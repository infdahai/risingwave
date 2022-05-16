/*
 * Copyright 2022 Singularity Data
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */
import createView, { computeNodeAddrToSideColor } from "../lib/streamPlan/streamChartHelper";
import { useEffect, useRef, useState } from "react";
import LocationSearchingIcon from "@mui/icons-material/LocationSearching";
import CircularProgress from "@mui/material/CircularProgress";
import SearchIcon from "@mui/icons-material/Search";
import RefreshIcon from "@mui/icons-material/Refresh";
import { Stack, Tabs, Tab, Box } from "@mui/material";
import {
  Tooltip,
  FormControl,
  Select,
  MenuItem,
  InputLabel,
  FormHelperText,
  Input,
  InputAdornment,
  IconButton,
  Autocomplete,
  TextField,
  Switch,
} from "@mui/material";
import { CanvasEngine } from "../lib/graaphEngine/canvasEngine";
import useWindowSize from "../hook/useWindowSize";
import { Close } from "@mui/icons-material";
import { SvgBox, SvgBoxCover } from "./SvgBox";
import { ToolBoxTitle } from "./ToolBox";
import JsonView from "./JsonView";
import { ActorInfoView } from "./ActorInfoView";

export default function StreamingView(props) {
  const { data } = props;
  const { mvList } = props;
  const actorList = data.map((x) => x.node);

  const [nodeJson, setNodeJson] = useState("");
  const [showInfoPane, setShowInfoPane] = useState(false);
  const [selectedWorkerNode, setSelectedWorkerNode] = useState("Show All");
  const [searchType, setSearchType] = useState("Actor");
  const [searchContent, setSearchContent] = useState("");
  const [mvTableIdToSingleViewActorList, setMvTableIdToSingleViewActorList] = useState(null);
  const [mvTableIdToChainViewActorList, setMvTableIdToChainViewActorList] = useState(null);
  const [filterMode, setFilterMode] = useState("Chain View");
  const [selectedMvTableId, setSelectedMvTableId] = useState(null);
  const [showFullGraph, setShowFullGraph] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tabValue, setTabValue] = useState(0);
  const [actor, setActor] = useState(null);

  const canvasRef = useRef(null);
  const canvasOutterBox = useRef(null);
  const engineRef = useRef(null);
  const viewRef = useRef(null);

  const setEngine = (e) => {
    engineRef.current = e;
  };

  const getEngine = () => {
    return engineRef.current;
  };

  const setView = (v) => {
    viewRef.current = v;
  };

  const getView = () => {
    return viewRef.current;
  };

  const exprNode = (actorNode) => (({ input, ...o }) => o)(actorNode);

  const locateTo = (selector) => {
    getEngine() && getEngine().locateTo(selector);
  };

  const onTabChange = (_, v) => {
    setTabValue(v);
  };

  const locateSearchPosition = () => {
    let type = searchType === "Operator" ? "Node" : searchType;
    type = type.toLocaleLowerCase();

    if (type === "actor") {
      locateTo(`${type}-${searchContent}`);
    }

    if (type === "fragment") {
      locateTo(`${type}-${searchContent}`);
    }
  };

  const onNodeClick = (e, node, actor) => {
    setActor(actor);
    setShowInfoPane(true);
    setNodeJson(
      node.dispatcherType
        ? JSON.stringify(
            {
              dispatcher: { type: node.dispatcherType },
              downstreamActorId: node.downstreamActorId,
            },
            null,
            2
          )
        : JSON.stringify(exprNode(node.nodeProto), null, 2)
    );
  };

  const onActorClick = (e, actor) => {
    setActor(actor);
    setShowInfoPane(true);
    setNodeJson("Click a node to show its raw json");
  };

  const onWorkerNodeSelect = (e) => {
    setSelectedWorkerNode(e.target.value);
  };

  const onSearchTypeChange = (e) => {
    setSearchType(e.target.value);
  };

  const onSearchButtonClick = (e) => {
    locateSearchPosition();
  };

  const onSearchBoxChange = (e) => {
    setSearchContent(e.target.value);
  };

  const onSelectMvChange = (e, v) => {
    setSelectedMvTableId(v === null ? null : v.tableId);
  };

  const onFilterModeChange = (e) => {
    setFilterMode(e.target.value);
  };

  const onFullGraphSwitchChange = (e, v) => {
    setShowFullGraph(v);
  };

  const locateToCurrentMviewActor = (actorIdList) => {
    if (actorIdList.length !== 0) {
      locateTo(`actor-${actorIdList[0]}`);
    }
  };

  const onReset = () => {
    getEngine().resetCamera();
  };

  const onRefresh = async () => {
    window.location.reload(true);
  };

  const resizeCanvas = () => {
    if (canvasOutterBox.current) {
      getEngine() &&
        getEngine().resize(
          canvasOutterBox.current.clientWidth,
          canvasOutterBox.current.clientHeight
        );
    }
  };

  const initGraph = (shownActorIdList) => {
    const newEngine = new CanvasEngine(
      "c",
      canvasRef.current.clientHeight,
      canvasRef.current.clientWidth
    );
    setEngine(newEngine);
    resizeCanvas();
    const newView = createView(
      newEngine,
      data,
      onNodeClick,
      onActorClick,
      selectedWorkerNode === "Show All" ? null : selectedWorkerNode,
      shownActorIdList
    );
    setView(newView);
  };

  const windowSize = useWindowSize();

  useEffect(() => {
    resizeCanvas();
  }, [windowSize]);

  useEffect(() => {
    locateSearchPosition();
  }, [searchType, searchContent]);

  // render the full graph
  useEffect(() => {
    if (canvasRef.current && showFullGraph) {
      initGraph(null);

      mvTableIdToSingleViewActorList ||
        setMvTableIdToSingleViewActorList(getView().getMvTableIdToSingleViewActorList());
      mvTableIdToChainViewActorList ||
        setMvTableIdToChainViewActorList(getView().getMvTableIdToChainViewActorList());
      return () => {
        getEngine().cleanGraph();
      };
    }
  }, [selectedWorkerNode, showFullGraph]);

  // locate and render partial graph on mview query
  useEffect(() => {
    if (selectedMvTableId === null) {
      return;
    }
    let shownActorIdList =
      (filterMode === "Chain View"
        ? mvTableIdToChainViewActorList
        : mvTableIdToSingleViewActorList
      ).get(selectedMvTableId) || [];
    if (!showFullGraph) {
      // rerender graph if it is a partial graph
      if (canvasRef.current) {
        initGraph(shownActorIdList);
        return () => {
          getEngine().cleanGraph();
        };
      }
    }
    locateToCurrentMviewActor(shownActorIdList);
  }, [selectedWorkerNode, filterMode, selectedMvTableId, showFullGraph]);

  return (
    <SvgBox>
      <SvgBoxCover style={{ right: "10px", top: "10px", width: "500px" }}>
        {showInfoPane ? (
          <Stack
            alignItems="center"
            width="100%"
            bgcolor="#fafafa"
            borderRadius={4}
            boxShadow="5px 5px 10px #ebebeb, -5px -5px 10px #ffffff"
            height={canvasOutterBox?.current ? canvasOutterBox.current.clientHeight - 100 : 500}
          >
            <Stack
              p={2}
              width="100%"
              height="50px"
              direction="row"
              alignItems="center"
              justifyContent="end"
              backgroundColor="#1a76d2"
              borderRadius="20px 20px 0 0"
            >
              <IconButton onClick={() => setShowInfoPane(false)}>
                <Close sx={{ color: "white" }} />
              </IconButton>
            </Stack>
            <Stack
              dirction="row"
              bgcolor="white"
              width="100%"
              justifyContent="center"
              alignItems="center"
            >
              <Tabs value={tabValue} onChange={onTabChange} aria-label="basic tabs example">
                <Tab label="Info" id={0} />
                <Tab label="Raw JSON" id={1} />
              </Tabs>
            </Stack>
            {tabValue === 0 ? <ActorInfoView actor={actor} /> : null}
            {tabValue === 1 ? <JsonView nodeJson={nodeJson} /> : null}
          </Stack>
        ) : null}
      </SvgBoxCover>

      <Stack className="noselect" zIndex={6} position="absolute">
        <ToolBoxTitle> Select a worker node </ToolBoxTitle>
        <FormControl sx={{ m: 1, minWidth: 300 }}>
          <InputLabel> Worker Node </InputLabel>
          <Select
            value={selectedWorkerNode || "Show All"}
            label="Woker Node"
            onChange={onWorkerNodeSelect}
          >
            <MenuItem value="Show All" key="all">
              Show All
            </MenuItem>
            {actorList.map((x, idx) => {
              return (
                <MenuItem
                  value={x}
                  key={idx}
                  sx={{ display: "flex", flexDirection: "row", alignItems: "center" }}
                >
                  {x.type}&nbsp;{" "}
                  <span style={{ fontWeight: 700 }}>{x.host.host + ":" + x.host.port}</span>
                  <div
                    style={{
                      margin: 5,
                      height: 10,
                      width: 10,
                      borderRadius: 5,
                      backgroundColor: computeNodeAddrToSideColor(x.host.host + ":" + x.host.port),
                    }}
                  />
                </MenuItem>
              );
            })}
          </Select>
          <FormHelperText> Select an Actor </FormHelperText>
        </FormControl>

        <ToolBoxTitle> Search </ToolBoxTitle>
        <Stack direction="row" alignItems="center">
          <FormControl sx={{ m: 1, minWidth: 120 }}>
            <InputLabel> Type </InputLabel>
            <Select value={searchType} label="Type" onChange={onSearchTypeChange}>
              <MenuItem value="Actor"> Actor </MenuItem>
              <MenuItem value="Fragment"> Fragment </MenuItem>
            </Select>
          </FormControl>
          <Input
            sx={{ m: 1, width: 150 }}
            label="Search"
            variant="standard"
            onChange={onSearchBoxChange}
            value={searchContent}
            endAdornment={
              <InputAdornment position="end">
                <IconButton aria-label="toggle password visibility" onClick={onSearchButtonClick}>
                  <SearchIcon />
                </IconButton>
              </InputAdornment>
            }
          />
        </Stack>

        <ToolBoxTitle> Filter materialized view </ToolBoxTitle>
        <Stack>
          <FormControl sx={{ m: 1, width: 300 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1}>
              <Box>
                <InputLabel> Mode </InputLabel>
                <Select
                  sx={{ width: 140 }}
                  value={filterMode}
                  label="Mode"
                  onChange={onFilterModeChange}
                >
                  <MenuItem value="Single View"> Single View </MenuItem>
                  <MenuItem value="Chain View"> Chain View </MenuItem>
                </Select>
              </Box>
              <Stack direction="row" alignItems="center" ml={1}>
                <Box> Full Graph </Box>
                <Switch defaultChecked value={showFullGraph} onChange={onFullGraphSwitchChange} />
              </Stack>
            </Stack>
            <Autocomplete
              isOptionEqualToValue={(option, value) => {
                return option.tableId === value.tableId;
              }}
              disablePortal
              options={
                mvList.map((mv) => {
                  return { label: mv.name, tableId: mv.id };
                }) || []
              }
              onChange={onSelectMvChange}
              renderInput={(param) => <TextField {...param} label="Materialized View" />}
            />
          </FormControl>
        </Stack>
      </Stack>

      <SvgBoxCover style={{ right: "10px", bottom: "10px", cursor: "pointer" }}>
        <Stack direction="row" spacing={2}>
          <Tooltip title="Reset">
            <Box onClick={() => onReset()}>
              <LocationSearchingIcon color="action" />
            </Box>
          </Tooltip>

          <Tooltip title="refresh">
            {!refreshing ? (
              <Box onClick={() => onRefresh()}>
                <RefreshIcon color="action" />
              </Box>
            ) : (
              <CircularProgress />
            )}
          </Tooltip>
        </Stack>
      </SvgBoxCover>

      <Box
        ref={canvasOutterBox}
        width="100%"
        height="100%"
        zIndex={5}
        overflow="auto"
        className="noselect"
      >
        <canvas ref={canvasRef} id="c" width={1000} height={1000} style={{ cursor: "pointer" }} />
      </Box>
    </SvgBox>
  );
}
