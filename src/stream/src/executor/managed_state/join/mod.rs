// Copyright 2022 Singularity Data
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

mod join_entry_state;
use std::alloc::Global;
use std::collections::BTreeMap;
use std::ops::{Deref, DerefMut, Index};

use futures::pin_mut;
use futures_async_stream::for_await;
use itertools::Itertools;
pub use join_entry_state::JoinEntryState;
use risingwave_common::array::Row;
use risingwave_common::catalog::{ColumnDesc, ColumnId};
use risingwave_common::collection::evictable::EvictableHashMap;
use risingwave_common::error::{ErrorCode, Result as RwResult, RwError};
use risingwave_common::hash::{HashKey, PrecomputedBuildHasher};
use risingwave_common::types::{DataType, Datum, ScalarImpl};
use risingwave_common::util::sort_util::OrderType;
use risingwave_storage::table::state_table::StateTable;
use risingwave_storage::{Keyspace, StateStore};
use stats_alloc::{SharedStatsAlloc, StatsAlloc};

type DegreeType = i64;
/// This is a row with a match degree
#[derive(Clone, Debug)]
pub struct JoinRow {
    pub row: Row,
    degree: DegreeType,
}

impl Index<usize> for JoinRow {
    type Output = Datum;

    fn index(&self, index: usize) -> &Self::Output {
        &self.row[index]
    }
}

impl JoinRow {
    pub fn new(row: Row, degree: DegreeType) -> Self {
        Self { row, degree }
    }

    #[allow(dead_code)]
    pub fn size(&self) -> usize {
        self.row.size()
    }

    pub fn is_zero_degree(&self) -> bool {
        self.degree == 0
    }

    pub fn inc_degree(&mut self) -> DegreeType {
        self.degree += 1;
        self.degree
    }

    pub fn dec_degree(&mut self) -> RwResult<DegreeType> {
        if self.degree == 0 {
            return Err(
                ErrorCode::InternalError("Tried to decrement zero join row degree".into()).into(),
            );
        }
        self.degree -= 1;
        Ok(self.degree)
    }

    pub fn row_by_indices(&self, indices: &[usize]) -> Row {
        Row(indices
            .iter()
            .map(|&idx| self.row.index(idx).to_owned())
            .collect_vec())
    }

    /// Make degree as the last datum of row
    pub fn into_row(mut self) -> Row {
        self.row.0.push(Some(ScalarImpl::Int64(self.degree)));
        self.row
    }

    /// Convert [`Row`] with last datum as degree to [`JoinRow`]
    pub fn from_row(row: Row) -> Self {
        let mut datums = row.0;
        let degree_datum = datums.pop().expect("missing degree in JoinRow").expect("degree should not be null");
        let degree = degree_datum.into_int64();
        JoinRow { row: Row(datums), degree }
    }
}

type PkType = Row;

pub type StateValueType = JoinRow;
pub type HashValueType = JoinEntryState;

type JoinHashMapInner<K> =
    EvictableHashMap<K, HashValueType, PrecomputedBuildHasher, SharedStatsAlloc<Global>>;

pub struct JoinHashMap<K: HashKey, S: StateStore> {
    /// Allocator
    alloc: SharedStatsAlloc<Global>,
    /// Store the join states.
    // SAFETY: This is a self-referential data structure and the allocator is owned by the struct
    // itself. Use the field is safe iff the struct is constructed with [`moveit`](https://crates.io/crates/moveit)'s way.
    inner: JoinHashMapInner<K>,
    /// Data types of the columns
    join_key_data_types: Vec<DataType>,
    /// Indices of the primary keys
    pk_indices: Vec<usize>,
    /// Current epoch
    current_epoch: u64,
    /// State table
    state_table: StateTable<S>,
}

impl<K: HashKey, S: StateStore> JoinHashMap<K, S> {
    /// Create a [`JoinHashMap`] with the given LRU capacity.
    pub fn new(
        target_cap: usize,
        pk_indices: Vec<usize>,
        join_key_indices: Vec<usize>,
        data_types: Vec<DataType>,
        keyspace: Keyspace<S>,
        dist_key_indices: Option<Vec<usize>>,
    ) -> Self {
        let join_key_data_types = join_key_indices
            .iter()
            .map(|idx| data_types[*idx].clone())
            .collect_vec();
        let column_descs = data_types
            .iter()
            .enumerate()
            .map(|(id, data_type)| ColumnDesc::unnamed(ColumnId::new(id as i32), data_type.clone()))
            .collect_vec();
        // Order type doesn't matter here. Arbitrarily choose one.
        let order_types = vec![OrderType::Descending; data_types.len()];

        let state_table = StateTable::new(
            keyspace.clone(),
            column_descs,
            order_types,
            dist_key_indices,
            pk_indices.clone(),
        );
        let alloc = StatsAlloc::new(Global).shared();
        Self {
            inner: EvictableHashMap::with_hasher_in(
                target_cap,
                PrecomputedBuildHasher,
                alloc.clone(),
            ),
            join_key_data_types,
            pk_indices,
            current_epoch: 0,
            state_table,
            alloc,
        }
    }

    #[allow(dead_code)]
    /// Report the bytes used by the join map.
    // FIXME: Currently, only memory used in the hash map itself is counted.
    pub fn bytes_in_use(&self) -> usize {
        self.alloc.bytes_in_use()
    }

    pub fn update_epoch(&mut self, epoch: u64) {
        self.current_epoch = epoch;
    }

    /// Returns a mutable reference to the value of the key in the memory, if does not exist, look
    /// up in remote storage and return, if still not exist, return None.
    #[allow(dead_code)]
    pub async fn get(&mut self, key: &K) -> Option<&HashValueType> {
        let state = self.inner.get(key);
        // TODO: we should probably implement a entry function for `LruCache`
        match state {
            Some(_) => self.inner.get(key),
            None => {
                let remote_state = self.fetch_cached_state(key).await.unwrap();
                remote_state.map(|rv| {
                    self.inner.put(key.clone(), rv);
                    self.inner.get(key).unwrap()
                })
            }
        }
    }

    /// Returns a mutable reference to the value of the key in the memory, if does not exist, look
    /// up in remote storage and return, if still not exist, return None.
    pub async fn get_mut(&mut self, key: &K) -> Option<&mut HashValueType> {
        let state = self.inner.get(key);
        // TODO: we should probably implement a entry function for `LruCache`
        match state {
            Some(_) => self.inner.get_mut(key),
            None => {
                let remote_state = self.fetch_cached_state(key).await.unwrap();
                remote_state.map(|rv| {
                    self.inner.put(key.clone(), rv);
                    self.inner.get_mut(key).unwrap()
                })
            }
        }
    }

    /// Returns true if the key in the memory or remote storage, otherwise false.
    #[allow(dead_code)]
    pub async fn contains(&mut self, key: &K) -> bool {
        let contains = self.inner.contains(key);
        if contains {
            true
        } else {
            let remote_state = self.fetch_cached_state(key).await.unwrap();
            match remote_state {
                Some(rv) => {
                    self.inner.put(key.clone(), rv);
                    true
                }
                None => false,
            }
        }
    }

    /// Fetch cache from the state store. Should only be called if the key does not exist in memory.
    async fn fetch_cached_state(&self, key: &K) -> RwResult<Option<JoinEntryState>> {
        let key = key.clone().deserialize(self.join_key_data_types.iter())?;
        
        let table_iter = self.state_table.iter_with_pk_prefix(key, self.current_epoch)?;
        pin_mut!(table_iter);

        let mut cached = BTreeMap::new();
        #[for_await]
        for row in table_iter {
            let row = row?.into_owned();
            let pk = row.by_indices(&self.pk_indices);

            cached.insert(pk, JoinRow::from_row(row));
        }
        Ok(Some(JoinEntryState::with_cached(cached)))
    }

    pub async fn flush(&mut self) -> RwResult<()> {
        self.state_table.commit_with_value_meta(self.current_epoch).await.map_err(|e| RwError::from(e))
    }

    /// Insert a key
    pub fn insert(&mut self, join_key: &K, pk: Row, value: JoinRow) -> RwResult<()>{
        if let Some(entry) = self.inner.get_mut(join_key) {
            entry.insert(pk, value.clone());
        }
        let key = join_key.clone().deserialize(self.join_key_data_types.iter())?;
        // If no cache maintained, only update the flush buffer.
        self.state_table.insert(&key, value.into_row())?;
        Ok(())
    }

    /// Delete a key
    pub fn delete(&mut self, join_key: &K, pk: Row, value: Row) -> RwResult<()>{
        if let Some(entry) = self.inner.get_mut(join_key) {
            entry.remove(pk);
        }
        let key = join_key.clone().deserialize(self.join_key_data_types.iter())?;
        // If no cache maintained, only update the flush buffer.
        self.state_table.delete(&key, value)?;
        Ok(())
    }
}

impl<K: HashKey, S: StateStore> Deref for JoinHashMap<K, S> {
    type Target = JoinHashMapInner<K>;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl<K: HashKey, S: StateStore> DerefMut for JoinHashMap<K, S> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.inner
    }
}
