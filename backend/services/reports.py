"""
Attendance analytics & export service.

Powers the admin dashboard KPIs and export endpoints:
- Daily summary metrics (total staff, present, clocked in/out, late, absent)
- Custom date-range aggregation reports
- Filtered CSV streaming export and JSON export

"Late" is determined by the ``is_late`` flag stamped on each record at
clock-in time, relative to the configured workplace ``work_start_time``
(default 09:00).
"""
import io
import csv
from datetime import datetime, timedelta, date
from typing import Any, Dict, Iterator, List, Optional, Tuple

from backend.config import get_now, get_today_str
from backend.database import get_db
from backend.services.schedules import (
    is_working_day,
    format_minutes_to_hours_mins,
    is_period_locked,
    get_employee_schedule_for_date,
)

DATE_FORMAT = "%Y-%m-%d"
CSV_HEADER = [
    "Record ID", "Staff ID", "Employee Name", "Department", "Date",
    "Clock In Time", "Clock In Distance (m)", "Clock Out Time",
    "Clock Out Distance (m)", "Status", "Late"
]

PAYROLL_CSV_HEADER = [
    "Staff ID", "Employee Name", "Department", "Date",
    "In", "Out", "Worked", "Break (min)", "Overtime (min)", "Late", "Presence Status"
]

VALID_STATUSES = ("CLOCKED_IN", "CLOCKED_OUT", "NOT_CLOCKED_IN", "ABSENT", "HOLIDAY", "OFF_DUTY")


# ---------------------------------------------------------------------------
# Date helpers / validation
# ---------------------------------------------------------------------------

def validate_date(value: Optional[str], field_name: str = "date") -> Optional[str]:
    """Validate that ``value`` is a YYYY-MM-DD string. Returns the value or None."""
    if value is None or value == "":
        return None
    val_clean = str(value).strip().lower()
    if val_clean in ("today", "current"):
        return get_today_str()
    try:
        datetime.strptime(str(value).strip(), DATE_FORMAT)
    except ValueError:
        raise ValueError(f"Invalid {field_name} '{value}'. Expected format: YYYY-MM-DD")
    return str(value).strip()


def validate_date_range(
    start_date: Optional[str],
    end_date: Optional[str]
) -> Tuple[Optional[str], Optional[str]]:
    """
    Validate an inclusive custom date range.
    - Both values must be YYYY-MM-DD.
    - start_date must not be after end_date.
    If only one bound is supplied it is treated as a single-day range.
    """
    start = validate_date(start_date, "start_date")
    end = validate_date(end_date, "end_date")

    if start and end and start > end:
        raise ValueError(f"start_date '{start}' must not be after end_date '{end}'")

    if start and not end:
        end = start
    if end and not start:
        start = end

    return start, end


# ---------------------------------------------------------------------------
# Shared attendance filter builder
# ---------------------------------------------------------------------------

def build_attendance_query(
    date: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    employee_id: Optional[int] = None,
    department: Optional[str] = None,
    status: Optional[str] = None,
    late_only: bool = False,
    search: Optional[str] = None
) -> Tuple[str, List[Any]]:
    """
    Build a parameterized WHERE clause over attendance_records joined with
    employees. Returns (sql_fragment_including_where, params).
    """
    conditions = ["1=1"]
    params: List[Any] = []

    if date:
        date_val = get_today_str() if str(date).strip().lower() in ("today", "current") else str(date).strip()
        conditions.append("a.date = ?")
        params.append(date_val)

    if start_date:
        conditions.append("a.date >= ?")
        params.append(start_date)

    if end_date:
        conditions.append("a.date <= ?")
        params.append(end_date)

    if employee_id is not None:
        conditions.append("a.employee_id = ?")
        params.append(employee_id)

    if department:
        conditions.append("LOWER(e.department) = LOWER(?)")
        params.append(department)

    if status:
        conditions.append("a.status = ?")
        params.append(status)

    if late_only:
        conditions.append("COALESCE(a.is_late, 0) = 1")

    if search:
        conditions.append("(e.name LIKE ? OR e.staff_id LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%"])

    return " AND ".join(conditions), params


def fetch_attendance_records(
    date: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    employee_id: Optional[int] = None,
    department: Optional[str] = None,
    status: Optional[str] = None,
    late_only: bool = False,
    search: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Retrieve attendance records (with employee details) matching the given
    filters. Used by the JSON export and the admin records endpoint.
    """
    where_clause, params = build_attendance_query(
        date=date, start_date=start_date, end_date=end_date,
        employee_id=employee_id, department=department, status=status,
        late_only=late_only, search=search
    )

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(f"""
        SELECT a.id, a.employee_id, e.staff_id, e.name, e.department, a.date,
               a.clock_in_time, a.clock_in_lat, a.clock_in_lon, a.clock_in_distance,
               a.clock_out_time, a.clock_out_lat, a.clock_out_lon, a.clock_out_distance,
               a.status, COALESCE(a.is_late, 0) AS is_late, a.notes
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
        WHERE {where_clause}
        ORDER BY a.date DESC, a.clock_in_time DESC, a.id DESC
    """, tuple(params))
    rows = cursor.fetchall()
    conn.close()

    return [dict(row) for row in rows]


def fetch_daily_roster(
    date: Optional[str] = None,
    department: Optional[str] = None,
    status: Optional[str] = None,
    late_only: bool = False,
    search: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Returns the complete live attendance roster for ALL registered staff for the given date (default today).
    Guarantees that all employees are accounted for with zero fluctuation:
    - Active shifts are marked CLOCKED_IN
    - Completed shifts are marked CLOCKED_OUT (Present)
    - Non-working days/holidays are marked HOLIDAY or OFF_DUTY
    - Employees scheduled to work but not yet clocked in are marked NOT_CLOCKED_IN (Absent / Pending)
    """
    if not date or str(date).strip().lower() in ("today", "current"):
        date_val = get_today_str()
    else:
        date_val = str(date).strip()

    conn = get_db()
    cursor = conn.cursor()

    conditions = ["1=1"]
    params: List[Any] = [date_val, date_val]

    if department:
        conditions.append("LOWER(e.department) = LOWER(?)")
        params.append(department)

    if status:
        st_upper = status.upper()
        if st_upper in ("ABSENT", "NOT_CLOCKED_IN"):
            conditions.append("(a.status IS NULL OR a.status IN ('NOT_CLOCKED_IN', 'ABSENT'))")
        else:
            conditions.append("a.status = ?")
            params.append(st_upper)

    if late_only:
        conditions.append("COALESCE(a.is_late, 0) = 1")

    if search:
        conditions.append("(LOWER(e.name) LIKE LOWER(?) OR LOWER(e.staff_id) LIKE LOWER(?))")
        params.extend([f"%{search}%", f"%{search}%"])

    where_clause = " AND ".join(conditions)

    sql = f"""
        SELECT 
            e.id AS employee_id,
            e.staff_id,
            e.name,
            e.department,
            e.email,
            COALESCE(a.date, ?) AS date,
            a.id AS id,
            a.clock_in_time,
            a.clock_in_lat,
            a.clock_in_lon,
            a.clock_in_distance,
            a.clock_out_time,
            a.clock_out_lat,
            a.clock_out_lon,
            a.clock_out_distance,
            COALESCE(a.status, 'NOT_CLOCKED_IN') AS status,
            COALESCE(a.is_late, 0) AS is_late,
            COALESCE(a.notes, 'Pending shift check-in') AS notes,
            a.started_at,
            a.ended_at,
            COALESCE(a.worked_minutes, 0) AS worked_minutes,
            COALESCE(a.break_minutes, 0) AS break_minutes,
            COALESCE(a.overtime_minutes, 0) AS overtime_minutes,
            a.schedule_id,
            s.name AS schedule_name
        FROM employees e
        LEFT JOIN attendance_records a ON e.id = a.employee_id AND a.date = ?
        LEFT JOIN schedules s ON a.schedule_id = s.id
        WHERE {where_clause}
        ORDER BY 
            CASE 
                WHEN a.status = 'CLOCKED_IN' THEN 1
                WHEN a.status = 'CLOCKED_OUT' THEN 2
                ELSE 3
            END,
            e.id ASC
    """
    cursor.execute(sql, tuple(params))
    rows = cursor.fetchall()

    results = []
    for r in rows:
        row_dict = dict(r)
        if not row_dict["id"]:
            # Evaluate schedule and working day status for employees without attendance record
            is_work, work_reason = is_working_day(cursor, row_dict["employee_id"], date_val)
            if not is_work:
                if "Holiday" in work_reason:
                    row_dict["status"] = "HOLIDAY"
                    row_dict["notes"] = work_reason
                else:
                    row_dict["status"] = "OFF_DUTY"
                    row_dict["notes"] = "Scheduled Rest Day / Weekend"
            else:
                row_dict["status"] = "NOT_CLOCKED_IN"
                row_dict["notes"] = "Pending shift check-in"
        results.append(row_dict)

    conn.close()
    return results


# ---------------------------------------------------------------------------
# Analytics: daily summary
# ---------------------------------------------------------------------------

def generate_daily_report(date_str: Optional[str] = None) -> Dict[str, Any]:
    """
    Compute daily attendance metrics for the given date (default: today).
    Late arrivals are records stamped late against the employee's assigned schedule.
    Weekends and holidays do not count as absences.
    """
    if not date_str or str(date_str).strip().lower() in ("today", "current"):
        date_str = get_today_str()
    else:
        date_str = str(date_str).strip()

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT id FROM employees")
    all_emp_ids = [r[0] for r in cursor.fetchall()]
    total_employees = len(all_emp_ids)

    cursor.execute("""
        SELECT employee_id, COALESCE(is_late, 0) AS is_late, status
        FROM attendance_records
        WHERE date = ?
    """, (date_str,))
    records = cursor.fetchall()

    record_emp_ids = {r["employee_id"]: r for r in records}

    total_present = sum(1 for r in records if r["status"] == "CLOCKED_OUT")
    clocked_in_now = sum(1 for r in records if r["status"] == "CLOCKED_IN")
    clocked_out = total_present
    late_arrivals = sum(1 for r in records if r["is_late"] == 1)

    # Absence evaluation: only count employees expected to work on date_str
    absent = 0
    for emp_id in all_emp_ids:
        if emp_id not in record_emp_ids:
            is_work, _ = is_working_day(cursor, emp_id, date_str)
            if is_work:
                absent += 1

    conn.close()

    return {
        "date": date_str,
        "total_employees": total_employees,
        "total_present": total_present,
        "clocked_in_now": clocked_in_now,
        "clocked_out": clocked_out,
        "late_arrivals": late_arrivals,
        "absent": absent
    }


# ---------------------------------------------------------------------------
# Analytics: custom date-range summary
# ---------------------------------------------------------------------------

def generate_range_report(start_date: str, end_date: str) -> Dict[str, Any]:
    """
    Aggregate attendance metrics across an inclusive custom date range.
    Weekends and holidays DO NOT count as absences in range reports.
    """
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT id FROM employees")
    all_emp_ids = [r[0] for r in cursor.fetchall()]
    total_employees = len(all_emp_ids)

    cursor.execute("""
        SELECT employee_id, date,
               COALESCE(is_late, 0) AS is_late,
               status
        FROM attendance_records
        WHERE date >= ? AND date <= ?
    """, (start_date, end_date))
    rows = cursor.fetchall()

    days = (datetime.strptime(end_date, DATE_FORMAT) -
            datetime.strptime(start_date, DATE_FORMAT)).days + 1

    distinct_staff_present = len({r["employee_id"] for r in rows if r["status"] == "CLOCKED_OUT"})
    completed_days = sum(1 for r in rows if r["status"] == "CLOCKED_OUT")
    clocked_in_now = sum(1 for r in rows if r["status"] == "CLOCKED_IN")
    clocked_out = completed_days
    late_arrivals = sum(1 for r in rows if r["is_late"] == 1)

    # Compute absences: iterate through each day in range and check working day status
    records_by_emp_date = {(r["employee_id"], r["date"]): r for r in rows}
    start_dt = datetime.strptime(start_date, DATE_FORMAT)
    end_dt = datetime.strptime(end_date, DATE_FORMAT)
    curr_dt = start_dt

    absent_employee_days = 0
    while curr_dt <= end_dt:
        d_str = curr_dt.strftime(DATE_FORMAT)
        for emp_id in all_emp_ids:
            if (emp_id, d_str) not in records_by_emp_date:
                is_work, _ = is_working_day(cursor, emp_id, d_str)
                if is_work:
                    absent_employee_days += 1
        curr_dt += timedelta(days=1)

    conn.close()

    return {
        "start_date": start_date,
        "end_date": end_date,
        "days": days,
        "total_employees": total_employees,
        "total_present": distinct_staff_present,
        "present_days": completed_days,
        "clocked_in_now": clocked_in_now,
        "clocked_out": clocked_out,
        "late_arrivals": late_arrivals,
        "absent": absent_employee_days
    }


# ---------------------------------------------------------------------------
# Export: CSV stream generator
# ---------------------------------------------------------------------------

def _format_csv_row(row: Dict[str, Any]) -> List[Any]:
    return [
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
    ]


def stream_attendance_csv(**filters: Any) -> Iterator[str]:
    """
    Generator that yields the CSV export line-by-line so large reports can be
    streamed without buffering the whole document in memory.
    Accepts the same keyword filters as fetch_attendance_records().
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer)

    writer.writerow(CSV_HEADER)
    yield buffer.getvalue()
    buffer.seek(0)
    buffer.truncate(0)

    for row in fetch_attendance_records(**filters):
        writer.writerow(_format_csv_row(row))
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)


def export_attendance_csv(**filters: Any) -> str:
    """Return the complete CSV export as a single string."""
    return "".join(stream_attendance_csv(**filters))


# ---------------------------------------------------------------------------
# Export: JSON
# ---------------------------------------------------------------------------

def export_attendance_json(**filters: Any) -> Dict[str, Any]:
    """
    Return attendance records matching the filters as a JSON-ready payload
    with metadata about the applied filters.
    """
    records = fetch_attendance_records(**filters)
    applied_filters = {
        key: value for key, value in filters.items()
        if value not in (None, False, "")
    }
    return {
        "exported_at": get_now().isoformat(),
        "count": len(records),
        "filters": applied_filters,
        "records": records
    }


# ---------------------------------------------------------------------------
# Timesheet aggregation (Daily, Weekly, Monthly per employee & team)
# ---------------------------------------------------------------------------

def _resolve_period_dates(
    period: Optional[str],
    date_str: Optional[str],
    start_date: Optional[str],
    end_date: Optional[str]
) -> Tuple[str, str]:
    """Resolve start_date and end_date based on period preset or explicit dates."""
    today = get_today_str()
    anchor_str = date_str or today

    if start_date and end_date:
        return start_date, end_date

    p = (period or "").lower().strip()
    try:
        anchor_dt = datetime.strptime(anchor_str, DATE_FORMAT)
    except ValueError:
        anchor_dt = datetime.strptime(today, DATE_FORMAT)

    if p == "daily":
        d = anchor_dt.strftime(DATE_FORMAT)
        return d, d
    elif p == "weekly":
        # Monday to Sunday
        start_dt = anchor_dt - timedelta(days=anchor_dt.weekday())
        end_dt = start_dt + timedelta(days=6)
        return start_dt.strftime(DATE_FORMAT), end_dt.strftime(DATE_FORMAT)
    elif p == "monthly":
        start_dt = anchor_dt.replace(day=1)
        if anchor_dt.month == 12:
            next_m = anchor_dt.replace(year=anchor_dt.year + 1, month=1, day=1)
        else:
            next_m = anchor_dt.replace(month=anchor_dt.month + 1, day=1)
        end_dt = next_m - timedelta(days=1)
        return start_dt.strftime(DATE_FORMAT), end_dt.strftime(DATE_FORMAT)

    # Default: single day if date provided, or today
    d = anchor_dt.strftime(DATE_FORMAT)
    return d, d


def generate_timesheet_report(
    date: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    employee_id: Optional[int] = None,
    department: Optional[str] = None,
    period: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Computes comprehensive daily, weekly or monthly timesheets per employee and per team.
    Includes totals, late counts, absence counts (excluding weekends & holidays),
    and verified presence minutes.
    """
    start, end = _resolve_period_dates(period, date, start_date, end_date)

    conn = get_db()
    cursor = conn.cursor()

    # 1. Fetch matching employees
    emp_conditions = ["1=1"]
    emp_params: List[Any] = []
    if employee_id is not None:
        emp_conditions.append("id = ?")
        emp_params.append(employee_id)
    if department:
        emp_conditions.append("LOWER(department) = LOWER(?)")
        emp_params.append(department)

    cursor.execute(f"""
        SELECT id, staff_id, name, email, department
        FROM employees
        WHERE {' AND '.join(emp_conditions)}
        ORDER BY id ASC
    """, tuple(emp_params))
    employees = [dict(r) for r in cursor.fetchall()]

    # 2. Fetch all attendance records in range
    cursor.execute("""
        SELECT a.*, s.name AS schedule_name, s.overtime_threshold_daily_minutes
        FROM attendance_records a
        LEFT JOIN schedules s ON a.schedule_id = s.id
        WHERE a.date >= ? AND a.date <= ?
    """, (start, end))
    records = cursor.fetchall()

    rec_map: Dict[Tuple[int, str], Dict[str, Any]] = {
        (r["employee_id"], r["date"]): dict(r) for r in records
    }

    # Date range list
    start_dt = datetime.strptime(start, DATE_FORMAT)
    end_dt = datetime.strptime(end, DATE_FORMAT)
    date_list = []
    curr = start_dt
    while curr <= end_dt:
        date_list.append(curr.strftime(DATE_FORMAT))
        curr += timedelta(days=1)

    employee_summaries = []
    total_scheduled_days = 0
    total_worked_days = 0
    total_absent_days = 0
    total_late_count = 0
    total_worked_minutes = 0
    total_break_minutes = 0
    total_overtime_minutes = 0
    total_verified_presence_minutes = 0

    for emp in employees:
        emp_id = emp["id"]
        sched_days = 0
        w_days = 0
        a_days = 0
        l_count = 0
        w_mins = 0
        b_mins = 0
        daily_ot_mins = 0
        verified_mins = 0
        emp_daily_records = []

        for d_str in date_list:
            is_work, reason = is_working_day(cursor, emp_id, d_str)
            if is_work:
                sched_days += 1

            rec = rec_map.get((emp_id, d_str))
            if rec:
                st = rec["status"]
                is_completed = (st == "CLOCKED_OUT")
                if is_completed or st == "CLOCKED_IN":
                    w_days += 1
                if rec.get("is_late"):
                    l_count += 1

                record_wm = rec.get("worked_minutes") or 0
                record_bm = rec.get("break_minutes") or 0
                record_ot = rec.get("overtime_minutes") or 0

                w_mins += record_wm
                b_mins += record_bm
                daily_ot_mins += record_ot

                # Verified presence (within geofence perimeter)
                dist = rec.get("clock_in_distance")
                if dist is not None and dist <= 150.0:
                    verified_mins += record_wm

                emp_daily_records.append({
                    "date": d_str,
                    "status": st,
                    "clock_in_time": rec.get("clock_in_time"),
                    "clock_out_time": rec.get("clock_out_time"),
                    "worked_minutes": record_wm,
                    "break_minutes": record_bm,
                    "overtime_minutes": record_ot,
                    "is_late": bool(rec.get("is_late")),
                    "is_working_day": is_work,
                    "day_type": "WORK_DAY" if is_work else ("HOLIDAY" if "Holiday" in reason else "REST_DAY")
                })
            else:
                if is_work:
                    a_days += 1
                emp_daily_records.append({
                    "date": d_str,
                    "status": "NOT_CLOCKED_IN" if is_work else ("HOLIDAY" if "Holiday" in reason else "OFF_DUTY"),
                    "clock_in_time": None,
                    "clock_out_time": None,
                    "worked_minutes": 0,
                    "break_minutes": 0,
                    "overtime_minutes": 0,
                    "is_late": False,
                    "is_working_day": is_work,
                    "day_type": "WORK_DAY" if is_work else ("HOLIDAY" if "Holiday" in reason else "REST_DAY")
                })

        # Weekly overtime threshold: 2400 mins (40h)
        weekly_ot_mins = max(0, w_mins - 2400)
        tot_ot_mins = max(daily_ot_mins, weekly_ot_mins)

        total_scheduled_days += sched_days
        total_worked_days += w_days
        total_absent_days += a_days
        total_late_count += l_count
        total_worked_minutes += w_mins
        total_break_minutes += b_mins
        total_overtime_minutes += tot_ot_mins
        total_verified_presence_minutes += verified_mins

        current_sched = get_employee_schedule_for_date(cursor, emp_id, end)

        employee_summaries.append({
            "employee_id": emp_id,
            "staff_id": emp["staff_id"],
            "name": emp["name"],
            "department": emp["department"],
            "schedule_name": current_sched.get("name", "Standard Shift"),
            "days_scheduled": sched_days,
            "days_worked": w_days,
            "absence_count": a_days,
            "late_count": l_count,
            "worked_minutes": w_mins,
            "worked_hours": round(w_mins / 60.0, 2),
            "worked_display": format_minutes_to_hours_mins(w_mins),
            "break_minutes": b_mins,
            "daily_overtime_minutes": daily_ot_mins,
            "weekly_overtime_minutes": weekly_ot_mins,
            "total_overtime_minutes": tot_ot_mins,
            "total_overtime_hours": round(tot_ot_mins / 60.0, 2),
            "overtime_multiplier": 1.5,
            "verified_presence_minutes": verified_mins,
            "verified_presence_display": format_minutes_to_hours_mins(verified_mins),
            "daily_breakdown": emp_daily_records
        })

    # 3. Check if date range is covered by any locked payroll period
    cursor.execute("""
        SELECT * FROM payroll_periods
        WHERE status = 'LOCKED'
          AND start_date <= ? AND end_date >= ?
        LIMIT 1
    """, (start, end))
    locked_period = cursor.fetchone()
    conn.close()

    return {
        "period": period or "custom",
        "start_date": start,
        "end_date": end,
        "days_count": len(date_list),
        "is_locked": bool(locked_period),
        "locked_period_name": locked_period["name"] if locked_period else None,
        "summary": {
            "total_employees": len(employees),
            "total_scheduled_days": total_scheduled_days,
            "total_worked_days": total_worked_days,
            "total_absent_days": total_absent_days,
            "total_late_arrivals": total_late_count,
            "total_worked_minutes": total_worked_minutes,
            "total_worked_hours": round(total_worked_minutes / 60.0, 2),
            "total_worked_display": format_minutes_to_hours_mins(total_worked_minutes),
            "total_overtime_minutes": total_overtime_minutes,
            "total_overtime_hours": round(total_overtime_minutes / 60.0, 2),
            "total_break_minutes": total_break_minutes,
            "verified_presence_minutes": total_verified_presence_minutes,
            "verified_presence_display": format_minutes_to_hours_mins(total_verified_presence_minutes),
            "overtime_multiplier": 1.5
        },
        "employees": employee_summaries
    }


# ---------------------------------------------------------------------------
# Payroll export: data generator & reconciler
# ---------------------------------------------------------------------------

def generate_payroll_export_data(
    start_date: str,
    end_date: str,
    employee_id: Optional[int] = None,
    department: Optional[str] = None
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Generate employee-day rows and period summary for payroll export.
    Reconciles directly with timesheet totals for the locked period.
    """
    timesheet = generate_timesheet_report(
        start_date=start_date,
        end_date=end_date,
        employee_id=employee_id,
        department=department
    )

    rows: List[Dict[str, Any]] = []
    for emp in timesheet["employees"]:
        for d in emp["daily_breakdown"]:
            # Format display values
            w_mins = d["worked_minutes"]
            b_mins = d["break_minutes"]
            ot_mins = d["overtime_minutes"]
            is_late_str = "YES" if d["is_late"] else "NO"

            # Determine clean presence status
            st = d["status"]
            if st == "CLOCKED_OUT":
                presence_status = "PRESENT"
            elif st == "CLOCKED_IN":
                presence_status = "CLOCKED_IN"
            elif st == "HOLIDAY":
                presence_status = "HOLIDAY"
            elif st == "OFF_DUTY":
                presence_status = "REST_DAY"
            else:
                presence_status = "ABSENT" if d["is_working_day"] else "REST_DAY"

            rows.append({
                "staff_id": emp["staff_id"],
                "name": emp["name"],
                "department": emp["department"],
                "date": d["date"],
                "in": d["clock_in_time"] or "--:--",
                "out": d["clock_out_time"] or ("In Progress" if st == "CLOCKED_IN" else "--:--"),
                "worked": format_minutes_to_hours_mins(w_mins),
                "worked_minutes": w_mins,
                "break": b_mins,
                "overtime": ot_mins,
                "late": is_late_str,
                "presence_status": presence_status
            })

    return rows, timesheet["summary"]


def stream_payroll_csv(
    start_date: str,
    end_date: str,
    employee_id: Optional[int] = None,
    department: Optional[str] = None
) -> Iterator[str]:
    """Stream payroll rows as CSV with period summary appended."""
    rows, summary = generate_payroll_export_data(
        start_date, end_date, employee_id=employee_id, department=department
    )
    buffer = io.StringIO()
    writer = csv.writer(buffer)

    # 1. Header
    writer.writerow(PAYROLL_CSV_HEADER)
    yield buffer.getvalue()
    buffer.seek(0)
    buffer.truncate(0)

    # 2. Rows
    for r in rows:
        writer.writerow([
            r["staff_id"],
            r["name"],
            r["department"],
            r["date"],
            r["in"],
            r["out"],
            r["worked"],
            r["break"],
            r["overtime"],
            r["late"],
            r["presence_status"]
        ])
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)

    # 3. Period Summary Section
    writer.writerow([])
    writer.writerow(["--- PERIOD SUMMARY ---"])
    writer.writerow(["Period Range", f"{start_date} to {end_date}"])
    writer.writerow(["Total Employees", summary["total_employees"]])
    writer.writerow(["Total Scheduled Days", summary["total_scheduled_days"]])
    writer.writerow(["Total Days Worked", summary["total_worked_days"]])
    writer.writerow(["Total Absences (Excl. Holidays/Weekends)", summary["total_absent_days"]])
    writer.writerow(["Total Late Arrivals", summary["total_late_arrivals"]])
    writer.writerow(["Total Worked Hours", f"{summary['total_worked_hours']} h ({summary['total_worked_minutes']} min)"])
    writer.writerow(["Total Overtime Hours", f"{summary['total_overtime_hours']} h ({summary['total_overtime_minutes']} min)"])
    writer.writerow(["Total Break Minutes", summary["total_break_minutes"]])
    writer.writerow(["Verified Presence Minutes", summary["verified_presence_minutes"]])
    writer.writerow(["Overtime Multiplier", summary["overtime_multiplier"]])
    yield buffer.getvalue()
    buffer.seek(0)
    buffer.truncate(0)


def export_payroll_csv(
    start_date: str,
    end_date: str,
    employee_id: Optional[int] = None,
    department: Optional[str] = None
) -> str:
    """Return complete payroll CSV export as string."""
    return "".join(stream_payroll_csv(start_date, end_date, employee_id, department))


def export_payroll_xlsx(
    start_date: str,
    end_date: str,
    employee_id: Optional[int] = None,
    department: Optional[str] = None
) -> bytes:
    """Generate styled XLSX Excel spreadsheet for payroll export."""
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

    rows, summary = generate_payroll_export_data(
        start_date, end_date, employee_id=employee_id, department=department
    )

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Payroll Timesheet"

    # Color tokens
    header_fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")
    summary_fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")
    header_font = Font(name="Arial", size=11, bold=True, color="FFFFFF")
    bold_font = Font(name="Arial", size=10, bold=True)
    regular_font = Font(name="Arial", size=10)
    thin_border = Border(
        left=Side(style="thin", color="CBD5E1"),
        right=Side(style="thin", color="CBD5E1"),
        top=Side(style="thin", color="CBD5E1"),
        bottom=Side(style="thin", color="CBD5E1")
    )

    # Title Banner
    ws.merge_cells("A1:K1")
    title_cell = ws["A1"]
    title_cell.value = f"Clockify Payroll Export ({start_date} to {end_date})"
    title_cell.font = Font(name="Arial", size=14, bold=True, color="1E3A8A")
    title_cell.alignment = Alignment(horizontal="left", vertical="center")
    ws.row_dimensions[1].height = 28

    # Table Header (Row 3)
    header_row_idx = 3
    ws.row_dimensions[header_row_idx].height = 24
    for col_idx, col_name in enumerate(PAYROLL_CSV_HEADER, start=1):
        cell = ws.cell(row=header_row_idx, column=col_idx, value=col_name)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = thin_border

    # Data Rows
    current_row = 4
    for r in rows:
        ws.row_dimensions[current_row].height = 20
        row_values = [
            r["staff_id"],
            r["name"],
            r["department"],
            r["date"],
            r["in"],
            r["out"],
            r["worked"],
            r["break"],
            r["overtime"],
            r["late"],
            r["presence_status"]
        ]
        for col_idx, val in enumerate(row_values, start=1):
            cell = ws.cell(row=current_row, column=col_idx, value=val)
            cell.font = regular_font
            cell.border = thin_border
            if col_idx in (1, 4, 5, 6, 8, 9, 10, 11):
                cell.alignment = Alignment(horizontal="center", vertical="center")
            else:
                cell.alignment = Alignment(horizontal="left", vertical="center")
        current_row += 1

    # Blank row
    current_row += 1

    # Summary Section
    summary_title = ws.cell(row=current_row, column=1, value="PERIOD RECONCILIATION SUMMARY")
    summary_title.font = Font(name="Arial", size=12, bold=True, color="1E3A8A")
    ws.merge_cells(start_row=current_row, start_column=1, end_row=current_row, end_column=4)
    current_row += 1

    summary_items = [
        ("Period Range", f"{start_date} to {end_date}"),
        ("Total Employees", summary["total_employees"]),
        ("Total Scheduled Working Days", summary["total_scheduled_days"]),
        ("Total Days Worked", summary["total_worked_days"]),
        ("Total Absences (Excluding Weekends & Holidays)", summary["total_absent_days"]),
        ("Total Late Arrivals", summary["total_late_arrivals"]),
        ("Total Worked Hours", f"{summary['total_worked_hours']} h ({summary['total_worked_minutes']} min)"),
        ("Total Overtime Hours", f"{summary['total_overtime_hours']} h ({summary['total_overtime_minutes']} min)"),
        ("Total Break Minutes", summary["total_break_minutes"]),
        ("Verified Presence Minutes", f"{summary['verified_presence_minutes']} min"),
        ("Overtime Multiplier", f"{summary['overtime_multiplier']}x"),
    ]

    for label, val in summary_items:
        ws.row_dimensions[current_row].height = 20
        c1 = ws.cell(row=current_row, column=1, value=label)
        c1.font = bold_font
        c1.fill = summary_fill
        c1.border = thin_border
        ws.merge_cells(start_row=current_row, start_column=1, end_row=current_row, end_column=2)

        c2 = ws.cell(row=current_row, column=3, value=val)
        c2.font = regular_font
        c2.border = thin_border
        ws.merge_cells(start_row=current_row, start_column=3, end_row=current_row, end_column=4)
        current_row += 1

    # Column widths
    col_widths = [12, 24, 26, 13, 11, 13, 12, 13, 15, 10, 16]
    for i, w in enumerate(col_widths, start=1):
        col_letter = openpyxl.utils.get_column_letter(i)
        ws.column_dimensions[col_letter].width = w

    output = io.BytesIO()
    wb.save(output)
    return output.getvalue()
