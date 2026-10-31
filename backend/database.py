"""
Clockify database layer.

Uses PostgreSQL when DATABASE_URL (or POSTGRES_URL) is set, otherwise a local SQLite file.
The rest of the app only uses two functions from this file: init_db() and get_db().
"""
import os
import ssl
import sqlite3
import urllib.parse
from dotenv import load_dotenv

from backend.config import DB_PATH, DEFAULT_WORKPLACE, get_now

load_dotenv()  # read settings from a .env file, if there is one

DATABASE_URL = (os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
                or os.environ.get("POSTGRES_PRISMA_URL") or "")
IS_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))

_db_initialized = False  # becomes True once tables are created in this running server

# Starter staff: (staff_id, name, email, department, pin, is_admin)
SEED_STAFF = [
    ("EMP001", "Arogundade Habeebat", "habeebat@clockify.local", "Frontend Engineering", "1234", 0),
    ("EMP002", "Jonathan Jeremiah", "jeremiah@clockify.local", "Frontend & Mobile", "1234", 0),
    ("EMP003", "Usang Emmanuel", "usang@clockify.local", "Backend & Database", "1234", 0),
    ("EMP004", "Babatunde Daniel", "daniel@clockify.local", "Backend & Geolocation", "1234", 0),
    ("EMP005", "Ojomo Abiola", "abiola@clockify.local", "Frontend & Integration", "1234", 0),
    ("EMP006", "Talabi Josiah", "josiah@clockify.local", "Backend & Security", "1234", 0),
    ("EMP007", "Oluwasegun Adejumo", "adejumo@clockify.local", "Analytics & Admin", "1234", 0),
    ("EMP008", "Olajide Peter", "peter@clockify.local", "Frontend & Admin UI", "1234", 0),
    ("EMP009", "techAlhaji", "techalhaji@clockify.dev", "Lead Tech / Engineering Leadership", "1234", 1),
    ("EMP010", "Amina Bello", "amina@clockify.local", "Operations & Quality Assurance", "1234", 0),
]
INSERT_EMPLOYEE = """INSERT INTO employees (staff_id, name, email, department, pin, is_admin, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)"""


# ---------------------------------------------------------------------------
# PostgreSQL wrappers: let the team's SQLite-style code run unchanged on Postgres
# ---------------------------------------------------------------------------

class DictRow(dict):
    """A row readable by column name (row["name"]) or by position (row[0]), like sqlite3.Row."""
    def __init__(self, cols, vals):
        super().__init__(zip(cols, vals))
        self._vals = tuple(vals)

    def __getitem__(self, key):
        return self._vals[key] if isinstance(key, int) else super().__getitem__(key)


class PgCursor:
    """Makes a pg8000 cursor behave like a sqlite3 cursor."""
    def __init__(self, cursor):
        self._cur = cursor
        self.lastrowid = None

    def execute(self, sql, params=None):
        sql = sql.strip().rstrip(";").replace("?", "%s")  # SQLite uses ?, Postgres uses %s
        is_insert = sql.upper().startswith("INSERT INTO") and "RETURNING" not in sql.upper()
        if is_insert:
            sql += " RETURNING id"  # Postgres has no lastrowid, so ask for the new id
        if params is None:
            self._cur.execute(sql)
        else:
            self._cur.execute(sql, tuple(params))
        if is_insert:
            row = self._cur.fetchone()
            self.lastrowid = row[0] if row else None
        return self

    def _columns(self):
        return [col[0] for col in (self._cur.description or [])]

    def fetchone(self):
        row = self._cur.fetchone()
        return None if row is None else DictRow(self._columns(), row)

    def fetchall(self):
        cols = self._columns()
        return [DictRow(cols, row) for row in self._cur.fetchall()]

    @property
    def rowcount(self):
        return self._cur.rowcount

    def close(self):
        self._cur.close()


class PgConnection:
    """Makes a pg8000 connection hand out PgCursor objects."""
    def __init__(self, conn):
        self._conn = conn

    def cursor(self):
        return PgCursor(self._conn.cursor())

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()


# ---------------------------------------------------------------------------
# Connecting
# ---------------------------------------------------------------------------

def _connect_postgres():
    import pg8000.dbapi  # only imported when Postgres is actually used
    url = urllib.parse.urlparse(DATABASE_URL)
    host = url.hostname or "localhost"
    sslmode = urllib.parse.parse_qs(url.query).get("sslmode", [""])[0]

    ssl_context = None
    if sslmode in ("require", "verify-ca", "verify-full") or host not in ("localhost", "127.0.0.1"):
        ssl_context = ssl.create_default_context()  # encrypt the connection
        ssl_context.check_hostname = False           # but do not verify the certificate
        ssl_context.verify_mode = ssl.CERT_NONE

    return PgConnection(pg8000.dbapi.connect(
        user=urllib.parse.unquote(url.username or "postgres"),
        password=urllib.parse.unquote(url.password or ""),
        host=host,
        port=url.port or 5432,
        database=url.path.lstrip("/") or "postgres",
        ssl_context=ssl_context,
    ))


def _connect_sqlite():
    conn = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)  # usable from any thread
    conn.execute("PRAGMA journal_mode = WAL;")    # readers and writers do not block each other
    conn.execute("PRAGMA busy_timeout = 30000;")  # wait up to 30s if the file is locked
    conn.execute("PRAGMA synchronous = NORMAL;")  # faster writes, still safe with WAL
    conn.execute("PRAGMA foreign_keys = ON;")     # SQLite ignores foreign keys unless told
    conn.row_factory = sqlite3.Row                # rows readable by column name
    return conn


def _connect():
    return _connect_postgres() if IS_POSTGRES else _connect_sqlite()


# ---------------------------------------------------------------------------
# Setup: create tables and starter data
# ---------------------------------------------------------------------------

def _create_tables(cursor):
    # One schema for both engines; only the auto-increment id is written differently.
    # DOUBLE PRECISION keeps full GPS precision in Postgres (SQLite stores it as REAL).
    id_col = "SERIAL PRIMARY KEY" if IS_POSTGRES else "INTEGER PRIMARY KEY AUTOINCREMENT"

    cursor.execute(f"""
        CREATE TABLE IF NOT EXISTS employees (
            id {id_col},
            staff_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            department TEXT NOT NULL,
            pin TEXT DEFAULT '1234',
            is_admin INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )""")
    cursor.execute(f"""
        CREATE TABLE IF NOT EXISTS geofence_settings (
            id {id_col},
            name TEXT NOT NULL,
            latitude DOUBLE PRECISION NOT NULL,
            longitude DOUBLE PRECISION NOT NULL,
            radius_meters DOUBLE PRECISION NOT NULL,
            work_start_time TEXT DEFAULT '09:00',
            updated_at TEXT NOT NULL
        )""")
    cursor.execute(f"""
        CREATE TABLE IF NOT EXISTS attendance_records (
            id {id_col},
            employee_id INTEGER NOT NULL REFERENCES employees(id),
            date TEXT NOT NULL,
            clock_in_time TEXT,
            clock_in_lat DOUBLE PRECISION,
            clock_in_lon DOUBLE PRECISION,
            clock_in_distance DOUBLE PRECISION,
            clock_out_time TEXT,
            clock_out_lat DOUBLE PRECISION,
            clock_out_lon DOUBLE PRECISION,
            clock_out_distance DOUBLE PRECISION,
            status TEXT NOT NULL,
            is_late INTEGER DEFAULT 0,
            notes TEXT
        )""")

    # Old SQLite files were created before the is_admin column existed: add it if missing.
    if not IS_POSTGRES:
        cursor.execute("PRAGMA table_info(employees)")
        if "is_admin" not in [col[1] for col in cursor.fetchall()]:
            cursor.execute("ALTER TABLE employees ADD COLUMN is_admin INTEGER DEFAULT 0")


def _seed(cursor):
    now = get_now().isoformat()

    # 1. Office location, only if none exists yet
    cursor.execute("SELECT COUNT(*) FROM geofence_settings")
    if cursor.fetchone()[0] == 0:
        w = DEFAULT_WORKPLACE
        cursor.execute("""INSERT INTO geofence_settings
                          (name, latitude, longitude, radius_meters, work_start_time, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?)""",
                       (w["name"], w["latitude"], w["longitude"], w["radius_meters"], w["work_start_time"], now))

    # 2. Staff: fill an empty table, or repair an older database
    cursor.execute("SELECT COUNT(*) FROM employees")
    if cursor.fetchone()[0] == 0:
        for staff in SEED_STAFF:
            cursor.execute(INSERT_EMPLOYEE, staff + (now,))
    else:
        # Make sure the lead tech account is named correctly and has admin rights
        cursor.execute("""UPDATE employees
                          SET name = 'techAlhaji', email = 'techalhaji@clockify.dev',
                              department = 'Lead Tech / Engineering Leadership', is_admin = 1
                          WHERE staff_id = 'EMP009' OR name = 'Lead Tech' OR id = 9""")
        # Make sure the 10th test employee exists
        cursor.execute("SELECT COUNT(*) FROM employees WHERE staff_id = 'EMP010'")
        if cursor.fetchone()[0] == 0:
            cursor.execute(INSERT_EMPLOYEE, SEED_STAFF[-1] + (now,))


# ---------------------------------------------------------------------------
# The two functions the rest of the app uses
# ---------------------------------------------------------------------------

def init_db():
    """Create tables and starter data. Safe to run many times."""
    global _db_initialized
    conn = _connect()
    cursor = conn.cursor()
    _create_tables(cursor)
    _seed(cursor)
    conn.commit()
    conn.close()
    _db_initialized = True


def get_db():
    """Return a new database connection, setting up the tables first if needed.
    The caller must call conn.close() when done."""
    if not _db_initialized:
        init_db()
    return _connect()
