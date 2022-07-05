# /usr/bin/python python3
# Note: the module name is psycopg, not psycopg3
import psycopg


def conn_params() -> str:
    host = 'localhost'
    dbname = 'dev'
    user = 'root'
    port = '4566'
    return "host={} dbname={} user={} port={}".format(host, dbname, user, port)


def main():
    # Connect to an existing database
    with psycopg.connect(conn_params()) as conn:

        # Open a cursor to perform database operations
        with conn.cursor() as cur:

            # Execute a command: this creates a new table
            cur.execute("""
            CREATE TABLE test (
                id  PRIMARY KEY,
                num integer,
                data text)
            """)
            # Pass data to fill a query placeholders and let Psycopg perform
            # the correct conversion (no SQL injections!)
            cur.execute(
                "INSERT INTO test (num, data) VALUES (%s, %s)",
                (100, "abc'def"))

            # Query the database and obtain data as Python objects.
            cur.execute("SELECT * FROM test")
            cur.fetchone()
            # will return (1, 100, "abc'def")

            # You can use `cur.fetchmany()`, `cur.fetchall()` to return a list
            # of several records, or even iterate on the cursor
            for record in cur:
                print(record)

            # Make the changes to the database persistent
            conn.commit()


if __name__ == "__main__":
    main()
