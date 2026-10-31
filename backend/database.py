import sqlite3
from datetime import datetime
from backend.config import DB_PATH, DEFAULT_WORKPLACE

def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()

    # 1. Employees Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS employees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            staff_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            department TEXT NOT NULL,
            pin TEXT DEFAULT '1234',
            created_at TEXT NOT NULL
        )
    """)

    # 2. Workplace Geofence Settings Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS geofence_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            radius_meters REAL NOT NULL,
            work_start_time TEXT DEFAULT '09:00',
            updated_at TEXT NOT NULL
        )
    """)

    # 3. Attendance Records Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS attendance_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            clock_in_time TEXT,
            clock_in_lat REAL,
            clock_in_lon REAL,
            clock_in_distance REAL,
            clock_out_time TEXT,
            clock_out_lat REAL,
            clock_out_lon REAL,
            clock_out_distance REAL,
            status TEXT NOT NULL,
            is_late INTEGER DEFAULT 0,
            notes TEXT,
            FOREIGN KEY (employee_id) REFERENCES employees(id)
        )
    """)

    # 4. Rejected Boundary Attempts Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS boundary_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            attempted_at TEXT NOT NULL,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            distance_meters REAL NOT NULL,
            allowed_radius_meters REAL NOT NULL,
            FOREIGN KEY (employee_id) REFERENCES employees(id)
        )
    """)

    conn.commit()
    cursor.execute("SELECT COUNT(*) FROM geofence_settings")
    if cursor.fetchone()[0] == 0:
        now = datetime.now().isoformat()
        cursor.execute("""
            INSERT INTO geofence_settings (name, latitude, longitude, radius_meters, work_start_time, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (
            DEFAULT_WORKPLACE["name"],
            DEFAULT_WORKPLACE["latitude"],
            DEFAULT_WORKPLACE["longitude"],
            DEFAULT_WORKPLACE["radius_meters"],
            DEFAULT_WORKPLACE["work_start_time"],
            now
        ))
        conn.commit()

    # Seed Sample Employees if table is empty
    cursor.execute("SELECT COUNT(*) FROM employees")
    if cursor.fetchone()[0] == 0:
        now = datetime.now().isoformat()
        initial_employees = [
            ("EMP001", "Arogundade Habeebat", "habeebat@clockify.local", "Frontend Engineering", "1234"),
            ("EMP002", "Jonathan Jeremiah", "jeremiah@clockify.local", "Frontend & Mobile", "1234"),
            ("EMP003", "Usang Emmanuel", "usang@clockify.local", "Backend & Database", "1234"),
            ("EMP004", "Babatunde Daniel", "daniel@clockify.local", "Backend & Geolocation", "1234"),
            ("EMP005", "Ojomo Abiola", "abiola@clockify.local", "Frontend & Integration", "1234"),
            ("EMP006", "Talabi Josiah", "josiah@clockify.local", "Backend & Security", "1234"),
            ("EMP007", "Oluwasegun Adejumo", "adejumo@clockify.local", "Analytics & Admin", "1234"),
            ("EMP008", "Olajide Peter", "peter@clockify.local", "Frontend & Admin UI", "1234"),
            ("EMP009", "Lead Tech", "lead@clockify.local", "Engineering Leadership", "1234"),
        ]
        cursor.executemany("""
            INSERT INTO employees (staff_id, name, email, department, pin, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, [(emp[0], emp[1], emp[2], emp[3], emp[4], now) for emp in initial_employees])
        conn.commit()

    conn.close()
