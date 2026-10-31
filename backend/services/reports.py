import io
import csv
from datetime import datetime
from backend.database import get_db

def generate_daily_report(date_str: str = None) -> dict:
    """
    Computes daily attendance metrics for the given date (default today YYYY-MM-DD).
    """
    if not date_str:
        date_str = datetime.now().strftime("%Y-%m-%d")

    conn = get_db()
    cursor = conn.cursor()

    # Total employees
    cursor.execute("SELECT COUNT(*) FROM employees")
    total_employees = cursor.fetchone()[0]

    # Attendance rows for date
    cursor.execute("""
        SELECT a.*, e.name, e.department, e.staff_id 
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
        WHERE a.date = ?
    """, (date_str,))
    records = cursor.fetchall()

    total_present = len(records)
    clocked_in_now = sum(1 for r in records if r["status"] == "CLOCKED_IN")
    clocked_out = sum(1 for r in records if r["status"] == "CLOCKED_OUT")
    late_arrivals = sum(1 for r in records if r["is_late"] == 1)
    absent = max(0, total_employees - total_present)

    cursor.execute("SELECT COUNT(*) FROM boundary_attempts WHERE date = ?", (date_str,))
    outside_boundary_attempts = cursor.fetchone()[0]
    conn.close()

    return {
        "date": date_str,
        "total_employees": total_employees,
        "total_present": total_present,
        "clocked_in_now": clocked_in_now,
        "clocked_out": clocked_out,
        "late_arrivals": late_arrivals,
        "outside_boundary_attempts": outside_boundary_attempts,
        "absent": absent
    }

def export_attendance_csv(date_filter: str = None) -> str:
    """
    Generates a CSV string of attendance records.
    """
    conn = get_db()
    cursor = conn.cursor()

    if date_filter:
        cursor.execute("""
            SELECT a.id, e.staff_id, e.name, e.department, a.date, 
                   a.clock_in_time, a.clock_in_distance, a.clock_out_time, 
                   a.clock_out_distance, a.status, a.is_late
            FROM attendance_records a
            JOIN employees e ON a.employee_id = e.id
            WHERE a.date = ?
            ORDER BY a.clock_in_time DESC
        """, (date_filter,))
    else:
        cursor.execute("""
            SELECT a.id, e.staff_id, e.name, e.department, a.date, 
                   a.clock_in_time, a.clock_in_distance, a.clock_out_time, 
                   a.clock_out_distance, a.status, a.is_late
            FROM attendance_records a
            JOIN employees e ON a.employee_id = e.id
            ORDER BY a.date DESC, a.clock_in_time DESC
        """)

    rows = cursor.fetchall()
    conn.close()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Record ID", "Staff ID", "Employee Name", "Department", "Date",
        "Clock In Time", "Clock In Distance (m)", "Clock Out Time", 
        "Clock Out Distance (m)", "Status", "Late"
    ])

    for row in rows:
        writer.writerow([
            row["id"],
            row["staff_id"],
            row["name"],
            row["department"],
            row["date"],
            row["clock_in_time"] or "N/A",
            row["clock_in_distance"] if row["clock_in_distance"] is not None else "N/A",
            row["clock_out_time"] or "N/A",
            row["clock_out_distance"] if row["clock_out_distance"] is not None else "N/A",
            row["status"],
            "YES" if row["is_late"] else "NO"
        ])

    return output.getvalue()
