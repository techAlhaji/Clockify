"""
Admin & Analytics endpoints.

- Workplace geofence configuration (GET/PUT /api/admin/geofence)
- Daily & custom date-range attendance analytics (/api/admin/metrics)
- Filtered attendance records (/api/admin/records)
- CSV streaming & JSON exports (/api/admin/export/*)
"""
from fastapi import APIRouter, HTTPException, Query, Response, Depends
from fastapi.responses import StreamingResponse
from datetime import datetime, timedelta
from typing import Optional

from backend.config import get_now, get_today_str
from backend.database import get_db
from backend.models import (
    GeofenceModel,
    AttendanceModel,
    ScheduleModel,
    ShiftAssignmentModel,
    HolidayModel,
    PayrollPeriodModel,
)
from backend.routers.auth import require_admin
from backend.schemas import (
    GeofenceUpdate,
    ScheduleCreate,
    ScheduleUpdate,
    ShiftAssignmentCreate,
    ShiftAssignmentUpdate,
    HolidayCreate,
    PayrollPeriodCreate,
)
from backend.services.reports import (
    generate_daily_report,
    generate_range_report,
    fetch_attendance_records,
    fetch_daily_roster,
    stream_attendance_csv,
    export_attendance_json,
    validate_date,
    validate_date_range,
    VALID_STATUSES,
    generate_timesheet_report,
    generate_payroll_export_data,
    stream_payroll_csv,
    export_payroll_csv,
    export_payroll_xlsx,
)

router = APIRouter(prefix="/api/admin", tags=["Admin"])


# ---------------------------------------------------------------------------
# Geofence configuration
# ---------------------------------------------------------------------------

@router.get("/geofence")
def get_geofence():
    """Retrieve current active workplace geofence coordinates and radius."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM geofence_settings ORDER BY id DESC LIMIT 1")
    row = cursor.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="No geofence settings configured")

    return GeofenceModel.to_dict(row)


@router.put("/geofence", dependencies=[Depends(require_admin)])
def update_geofence(payload: GeofenceUpdate):
    """
    Update the active workplace coordinates, radius and shift start time.
    Changes take effect immediately — clock-in/out validation reads the
    latest saved settings on every request.
    """
    # Validate shift start time format (24h HH:MM)
    work_start_time = payload.work_start_time or "09:00"
    try:
        datetime.strptime(work_start_time, "%H:%M")
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid work_start_time '{work_start_time}'. Expected 24-hour format HH:MM (e.g. 09:00)."
        )

    conn = get_db()
    cursor = conn.cursor()
    now = get_now().isoformat()

    cursor.execute("""
        UPDATE geofence_settings
        SET name = ?,
            latitude = ?,
            longitude = ?,
            radius_meters = ?,
            work_start_time = ?,
            updated_at = ?
        WHERE id = (SELECT id FROM geofence_settings ORDER BY id DESC LIMIT 1)
    """, (
        payload.name or "Workplace Headquarters",
        payload.latitude,
        payload.longitude,
        payload.radius_meters,
        work_start_time,
        now
    ))

    # If no settings row existed yet, seed the first configuration (CRUD upsert)
    if cursor.rowcount == 0:
        cursor.execute("""
            INSERT INTO geofence_settings
                (name, latitude, longitude, radius_meters, work_start_time, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (
            payload.name or "Workplace Headquarters",
            payload.latitude,
            payload.longitude,
            payload.radius_meters,
            work_start_time,
            now
        ))

    conn.commit()

    cursor.execute("SELECT * FROM geofence_settings ORDER BY id DESC LIMIT 1")
    row = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": "Workplace geofence successfully updated",
        "geofence": GeofenceModel.to_dict(row)
    }


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------

@router.get("/metrics", dependencies=[Depends(require_admin)])
def get_admin_metrics(
    response: Response,
    date: Optional[str] = Query(None, description="Single day (YYYY-MM-DD). Defaults to today."),
    start_date: Optional[str] = Query(None, description="Range start (YYYY-MM-DD, inclusive)."),
    end_date: Optional[str] = Query(None, description="Range end (YYYY-MM-DD, inclusive).")
):
    """
    Daily summary KPIs for the admin dashboard.
    Pass `date` for a single-day report, or `start_date`/`end_date` for a
    custom date-range aggregation report.
    """
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    try:
        day = validate_date(date, "date")
        start, end = validate_date_range(start_date, end_date)

        if day and (start or end):
            raise ValueError("Use either 'date' or 'start_date'/'end_date', not both.")

        if start and end:
            if start == end:
                return generate_daily_report(start)
            return generate_range_report(start, end)

        return generate_daily_report(day)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("/records", dependencies=[Depends(require_admin)])
def get_attendance_records(
    response: Response,
    date: Optional[str] = Query(None, description="Filter by exact date (YYYY-MM-DD)."),
    start_date: Optional[str] = Query(None, description="Range start (YYYY-MM-DD, inclusive)."),
    end_date: Optional[str] = Query(None, description="Range end (YYYY-MM-DD, inclusive)."),
    employee_id: Optional[int] = Query(None, description="Filter by employee primary ID."),
    department: Optional[str] = Query(None, description="Filter by department (case-insensitive)."),
    status: Optional[str] = Query(None, description="Filter by status: CLOCKED_IN, CLOCKED_OUT, or NOT_CLOCKED_IN/ABSENT."),
    late_only: bool = Query(False, description="Return only late arrivals."),
    search: Optional[str] = Query(None, description="Search employee name or staff ID."),
    view: Optional[str] = Query(None, description="View mode: 'roster' (complete live roster for all staff) or 'history' (logged sessions only)")
):
    """
    Retrieve attendance records.
    - When view='roster' (or by default for today's live monitoring): returns the complete status of all staff members.
    - When view='history' or when querying date ranges: returns logged clock-in / clock-out session events.
    """
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    try:
        day = validate_date(date, "date")
        start, end = validate_date_range(start_date, end_date)

        if day and (start or end):
            raise ValueError("Use either 'date' or 'start_date'/'end_date', not both.")

        # If live roster view is requested (or default single-day monitoring when not querying historical ranges/employee)
        today_str = get_today_str()
        is_today_or_single_day = (day is not None and not start and not end and not employee_id) or (date is None and not start and not end and not employee_id)
        if view == "roster" or (view != "history" and is_today_or_single_day):
            target_day = day or today_str
            return fetch_daily_roster(
                date=target_day,
                department=department,
                status=status,
                late_only=late_only,
                search=search
            )

        if status and status.upper() not in VALID_STATUSES:
            raise ValueError(
                f"Invalid status '{status}'. Expected one of: {', '.join(VALID_STATUSES)}."
            )

        records = fetch_attendance_records(
            date=day, start_date=start, end_date=end,
            employee_id=employee_id,
            department=department,
            status=status.upper() if status else None,
            late_only=late_only,
            search=search
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    return [AttendanceModel.to_dict(record) for record in records]



# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------

def _validate_export_filters(date, start_date, end_date, status):
    """Validate shared export query filters; returns normalized values."""
    day = validate_date(date, "date")
    start, end = validate_date_range(start_date, end_date)

    if day and (start or end):
        raise ValueError("Use either 'date' or 'start_date'/'end_date', not both.")

    normalized_status = None
    if status:
        normalized_status = status.upper()
        if normalized_status not in VALID_STATUSES:
            raise ValueError(
                f"Invalid status '{status}'. Expected one of: {', '.join(VALID_STATUSES)}."
            )

    return day, start, end, normalized_status


def _export_filename(ext: str, day=None, start=None, end=None) -> str:
    if day:
        label = day
    elif start and end:
        label = f"{start}_to_{end}"
    else:
        label = "all"
    return f"attendance_report_{label}.{ext}"


@router.get("/export/csv", dependencies=[Depends(require_admin)])
def download_attendance_csv(
    date: Optional[str] = Query(None, description="Filter by exact date (YYYY-MM-DD)."),
    start_date: Optional[str] = Query(None, description="Range start (YYYY-MM-DD, inclusive)."),
    end_date: Optional[str] = Query(None, description="Range end (YYYY-MM-DD, inclusive)."),
    employee_id: Optional[int] = Query(None, description="Filter by employee primary ID."),
    department: Optional[str] = Query(None, description="Filter by department (case-insensitive)."),
    status: Optional[str] = Query(None, description="Filter by status: CLOCKED_IN or CLOCKED_OUT."),
    late_only: bool = Query(False, description="Export only late arrivals.")
):
    """Stream the attendance log as a downloadable CSV file (supports custom date ranges)."""
    try:
        day, start, end, normalized_status = _validate_export_filters(
            date, start_date, end_date, status
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    filename = _export_filename("csv", day, start, end)

    return StreamingResponse(
        stream_attendance_csv(
            date=day, start_date=start, end_date=end,
            employee_id=employee_id, department=department,
            status=normalized_status, late_only=late_only
        ),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@router.get("/export/json", dependencies=[Depends(require_admin)])
def download_attendance_json(
    date: Optional[str] = Query(None, description="Filter by exact date (YYYY-MM-DD)."),
    start_date: Optional[str] = Query(None, description="Range start (YYYY-MM-DD, inclusive)."),
    end_date: Optional[str] = Query(None, description="Range end (YYYY-MM-DD, inclusive)."),
    employee_id: Optional[int] = Query(None, description="Filter by employee primary ID."),
    department: Optional[str] = Query(None, description="Filter by department (case-insensitive)."),
    status: Optional[str] = Query(None, description="Filter by status: CLOCKED_IN or CLOCKED_OUT."),
    late_only: bool = Query(False, description="Export only late arrivals.")
):
    """Export the filtered attendance log as JSON (supports custom date ranges)."""
    try:
        day, start, end, normalized_status = _validate_export_filters(
            date, start_date, end_date, status
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    return export_attendance_json(
        date=day, start_date=start, end_date=end,
        employee_id=employee_id, department=department,
        status=normalized_status, late_only=late_only
    )


# ---------------------------------------------------------------------------
# Demo data
# ---------------------------------------------------------------------------

@router.post("/seed-demo-data", dependencies=[Depends(require_admin)])
def seed_demo_data():
    """Populates realistic sample attendance records across team members for demonstration."""
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT id, name FROM employees ORDER BY id ASC")
    employees = cursor.fetchall()
    if not employees:
        conn.close()
        raise HTTPException(status_code=400, detail="No employees found to seed demo records for.")

    today_str = get_today_str()
    yesterday_str = (get_now() - timedelta(days=1)).strftime("%Y-%m-%d")

    cursor.execute("SELECT latitude, longitude FROM geofence_settings ORDER BY id DESC LIMIT 1")
    geo = cursor.fetchone()
    lat = geo["latitude"] if geo else 6.5244
    lon = geo["longitude"] if geo else 3.3792

    # Remove today's existing records to prevent duplication on multiple seed clicks
    cursor.execute("DELETE FROM attendance_records WHERE date IN (?, ?)", (today_str, yesterday_str))

    sample_configs = [
        ("08:35:12", lat + 0.0001, lon + 0.0001, 12.4, "17:02:10", lat, lon, 18.2, "CLOCKED_OUT", 0, "On time (Verified)"),
        ("08:48:00", lat, lon, 8.3, None, None, None, None, "CLOCKED_IN", 0, "Active on-site shift"),
        ("08:52:19", lat - 0.0001, lon + 0.0002, 24.1, None, None, None, None, "CLOCKED_IN", 0, "On time (Office GPS)"),
        ("09:14:40", lat + 0.0003, lon - 0.0002, 38.6, None, None, None, None, "CLOCKED_IN", 1, "Late arrival (Traffic on Ikorodu Rd)"),
        ("08:29:10", lat, lon, 11.0, "17:15:00", lat, lon, 15.0, "CLOCKED_OUT", 0, "Completed shift"),
        ("09:08:44", lat, lon, 22.1, "16:55:12", lat, lon, 25.4, "CLOCKED_OUT", 1, "Late arrival (Verified)"),
        ("08:40:05", lat + 0.0002, lon, 19.5, None, None, None, None, "CLOCKED_IN", 0, "Active shift"),
        ("08:58:30", lat, lon - 0.0001, 14.8, None, None, None, None, "CLOCKED_IN", 0, "On time"),
        ("08:31:00", lat, lon, 9.4, "17:05:00", lat, lon, 12.0, "CLOCKED_OUT", 0, "Completed shift"),
        ("09:02:15", lat + 0.0001, lon, 16.2, None, None, None, None, "CLOCKED_IN", 1, "Late arrival (Office GPS)"),
    ]

    for i, emp in enumerate(employees):
        emp_id = emp["id"]
        cfg = sample_configs[i % len(sample_configs)]
        clock_in_time = cfg[0]
        clock_out_time = cfg[4]
        status_val = cfg[8]
        is_late_val = cfg[9]
        notes_val = cfg[10]

        started_at = f"{today_str}T{clock_in_time}+01:00"
        ended_at = f"{today_str}T{clock_out_time}+01:00" if clock_out_time else None
        worked_m = 0
        break_m = 0
        ot_m = 0

        if status_val == "CLOCKED_OUT" and clock_out_time:
            # calculate worked minutes (e.g. 08:35 to 17:02 is ~507 mins - 60 break = 447 mins)
            t_in = datetime.strptime(f"{today_str} {clock_in_time}", "%Y-%m-%d %H:%M:%S")
            t_out = datetime.strptime(f"{today_str} {clock_out_time}", "%Y-%m-%d %H:%M:%S")
            elapsed = int((t_out - t_in).total_seconds() / 60)
            break_m = 60
            worked_m = max(0, elapsed - break_m)
            ot_m = max(0, worked_m - 480)

        cursor.execute("""
            INSERT INTO attendance_records (
                employee_id, date, clock_in_time, clock_in_lat, clock_in_lon,
                clock_in_distance, clock_out_time, clock_out_lat, clock_out_lon,
                clock_out_distance, status, is_late, notes, started_at, ended_at,
                worked_minutes, break_minutes, overtime_minutes, schedule_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        """, (
            emp_id, today_str, clock_in_time, cfg[1], cfg[2],
            cfg[3], clock_out_time, cfg[5], cfg[6], cfg[7],
            status_val, is_late_val, notes_val, started_at, ended_at,
            worked_m, break_m, ot_m
        ))

    conn.commit()
    conn.close()

    return {"status": "success", "message": f"Sample attendance records seeded across all {len(employees)} employees for today!"}


# ---------------------------------------------------------------------------
# Schedules & Shifts CRUD
# ---------------------------------------------------------------------------

@router.get("/schedules", dependencies=[Depends(require_admin)])
def list_schedules():
    """Retrieve all workplace shift schedules."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM schedules ORDER BY id ASC")
    rows = cursor.fetchall()
    conn.close()
    return [ScheduleModel.to_dict(r) for r in rows]


@router.post("/schedules", dependencies=[Depends(require_admin)])
def create_schedule(payload: ScheduleCreate):
    """Create a new work schedule (e.g. Morning, Afternoon, Night)."""
    start_time = payload.start_time or payload.start or "09:00"
    end_time = payload.end_time or payload.end or "17:00"

    # Validate HH:MM format
    for t_str, field in [(start_time, "start_time"), (end_time, "end_time")]:
        try:
            datetime.strptime(t_str, "%H:%M")
        except ValueError:
            raise HTTPException(status_code=422, detail=f"Invalid {field} '{t_str}'. Expected HH:MM format.")

    now = get_now().isoformat()
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("""
        INSERT INTO schedules (
            name, start_time, end_time, days_of_week, grace_minutes,
            break_minutes, break_is_paid, required_minutes, is_overnight,
            overtime_threshold_daily_minutes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        payload.name.strip(),
        start_time,
        end_time,
        payload.days_of_week or "1,2,3,4,5",
        payload.grace_minutes if payload.grace_minutes is not None else 5,
        payload.break_minutes if payload.break_minutes is not None else 60,
        payload.break_is_paid if payload.break_is_paid is not None else 0,
        payload.required_minutes if payload.required_minutes is not None else 480,
        payload.is_overnight if payload.is_overnight is not None else 0,
        payload.overtime_threshold_daily_minutes if payload.overtime_threshold_daily_minutes is not None else 480,
        now
    ))
    conn.commit()
    new_id = cursor.lastrowid
    cursor.execute("SELECT * FROM schedules WHERE id = ?", (new_id,))
    row = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": f"Schedule '{payload.name}' created successfully.",
        "schedule": ScheduleModel.to_dict(row)
    }


@router.put("/schedules/{schedule_id}", dependencies=[Depends(require_admin)])
def update_schedule(schedule_id: int, payload: ScheduleUpdate):
    """Update schedule properties."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM schedules WHERE id = ?", (schedule_id,))
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        raise HTTPException(status_code=404, detail="Schedule not found")

    start_time = payload.start_time or payload.start or existing["start_time"]
    end_time = payload.end_time or payload.end or existing["end_time"]
    name = payload.name.strip() if payload.name else existing["name"]
    days_of_week = payload.days_of_week if payload.days_of_week is not None else existing["days_of_week"]
    grace_minutes = payload.grace_minutes if payload.grace_minutes is not None else existing["grace_minutes"]
    break_minutes = payload.break_minutes if payload.break_minutes is not None else existing["break_minutes"]
    break_is_paid = payload.break_is_paid if payload.break_is_paid is not None else existing["break_is_paid"]
    required_minutes = payload.required_minutes if payload.required_minutes is not None else existing["required_minutes"]
    is_overnight = payload.is_overnight if payload.is_overnight is not None else existing["is_overnight"]
    ot_thresh = payload.overtime_threshold_daily_minutes if payload.overtime_threshold_daily_minutes is not None else existing["overtime_threshold_daily_minutes"]

    cursor.execute("""
        UPDATE schedules
        SET name = ?, start_time = ?, end_time = ?, days_of_week = ?,
            grace_minutes = ?, break_minutes = ?, break_is_paid = ?,
            required_minutes = ?, is_overnight = ?, overtime_threshold_daily_minutes = ?
        WHERE id = ?
    """, (
        name, start_time, end_time, days_of_week,
        grace_minutes, break_minutes, break_is_paid,
        required_minutes, is_overnight, ot_thresh, schedule_id
    ))
    conn.commit()

    cursor.execute("SELECT * FROM schedules WHERE id = ?", (schedule_id,))
    updated = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": f"Schedule '{name}' updated successfully.",
        "schedule": ScheduleModel.to_dict(updated)
    }


@router.delete("/schedules/{schedule_id}", dependencies=[Depends(require_admin)])
def delete_schedule(schedule_id: int):
    """Delete a schedule."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM schedules WHERE id = ?", (schedule_id,))
    conn.commit()
    conn.close()
    return {"status": "success", "message": f"Schedule {schedule_id} deleted"}


# ---------------------------------------------------------------------------
# Shift Assignments (Historical, effective-dated)
# ---------------------------------------------------------------------------

@router.get("/shift-assignments", dependencies=[Depends(require_admin)])
def list_shift_assignments(employee_id: Optional[int] = Query(None)):
    """Retrieve shift assignments (historical view)."""
    conn = get_db()
    cursor = conn.cursor()
    sql = """
        SELECT sa.*, e.name AS employee_name, e.staff_id, s.name AS schedule_name
        FROM shift_assignments sa
        JOIN employees e ON sa.employee_id = e.id
        JOIN schedules s ON sa.schedule_id = s.id
    """
    params = []
    if employee_id is not None:
        sql += " WHERE sa.employee_id = ?"
        params.append(employee_id)
    sql += " ORDER BY sa.effective_from DESC, sa.id DESC"

    cursor.execute(sql, tuple(params))
    rows = cursor.fetchall()
    conn.close()
    return [ShiftAssignmentModel.to_dict(r) for r in rows]


@router.post("/shift-assignments", dependencies=[Depends(require_admin)])
def create_shift_assignment(payload: ShiftAssignmentCreate):
    """Assign an employee to a shift schedule with historical effective dates."""
    validate_date(payload.effective_from, "effective_from")
    if payload.effective_to:
        validate_date(payload.effective_to, "effective_to")
        if payload.effective_from > payload.effective_to:
            raise HTTPException(status_code=422, detail="effective_from cannot be after effective_to")

    now = get_now().isoformat()
    conn = get_db()
    cursor = conn.cursor()

    # Check employee and schedule exist
    cursor.execute("SELECT id FROM employees WHERE id = ?", (payload.employee_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Employee not found")

    cursor.execute("SELECT id FROM schedules WHERE id = ?", (payload.schedule_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Schedule not found")

    cursor.execute("""
        INSERT INTO shift_assignments (
            employee_id, schedule_id, site_id, effective_from, effective_to, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
    """, (
        payload.employee_id,
        payload.schedule_id,
        payload.site_id,
        payload.effective_from,
        payload.effective_to,
        now
    ))
    conn.commit()
    new_id = cursor.lastrowid

    cursor.execute("""
        SELECT sa.*, e.name AS employee_name, e.staff_id, s.name AS schedule_name
        FROM shift_assignments sa
        JOIN employees e ON sa.employee_id = e.id
        JOIN schedules s ON sa.schedule_id = s.id
        WHERE sa.id = ?
    """, (new_id,))
    created = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": "Shift assignment recorded successfully.",
        "assignment": ShiftAssignmentModel.to_dict(created)
    }


@router.delete("/shift-assignments/{assignment_id}", dependencies=[Depends(require_admin)])
def delete_shift_assignment(assignment_id: int):
    """Delete a shift assignment."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM shift_assignments WHERE id = ?", (assignment_id,))
    conn.commit()
    conn.close()
    return {"status": "success", "message": f"Shift assignment {assignment_id} deleted"}


# ---------------------------------------------------------------------------
# Holidays / Calendar Management
# ---------------------------------------------------------------------------

@router.get("/holidays", dependencies=[Depends(require_admin)])
def list_holidays():
    """Retrieve all public holidays and calendar overrides."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM holidays ORDER BY date ASC")
    rows = cursor.fetchall()
    conn.close()
    return [HolidayModel.to_dict(r) for r in rows]


@router.post("/holidays", dependencies=[Depends(require_admin)])
def create_holiday(payload: HolidayCreate):
    """Add a calendar holiday or working-day override."""
    validate_date(payload.date, "date")
    now = get_now().isoformat()
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("""
        INSERT INTO holidays (date, name, scope, site_id, is_working_day, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        payload.date,
        payload.name.strip(),
        payload.scope or "company",
        payload.site_id,
        payload.is_working_day or 0,
        now
    ))
    conn.commit()
    new_id = cursor.lastrowid
    cursor.execute("SELECT * FROM holidays WHERE id = ?", (new_id,))
    row = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": f"Holiday '{payload.name}' added successfully.",
        "holiday": HolidayModel.to_dict(row)
    }


@router.delete("/holidays/{holiday_id}", dependencies=[Depends(require_admin)])
def delete_holiday(holiday_id: int):
    """Delete a calendar holiday."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM holidays WHERE id = ?", (holiday_id,))
    conn.commit()
    conn.close()
    return {"status": "success", "message": f"Holiday {holiday_id} deleted"}


# ---------------------------------------------------------------------------
# Timesheets View Endpoint (Daily, Weekly, Monthly per employee & team)
# ---------------------------------------------------------------------------

@router.get("/timesheets", dependencies=[Depends(require_admin)])
def get_admin_timesheets(
    period: Optional[str] = Query("daily", description="'daily', 'weekly', 'monthly', or 'custom'"),
    date: Optional[str] = Query(None, description="Anchor date (YYYY-MM-DD, defaults to today)"),
    start_date: Optional[str] = Query(None, description="Custom start date (inclusive)"),
    end_date: Optional[str] = Query(None, description="Custom end date (inclusive)"),
    employee_id: Optional[int] = Query(None, description="Filter by employee primary ID"),
    department: Optional[str] = Query(None, description="Filter by team/department"),
):
    """
    Retrieve daily, weekly, or monthly timesheet views per employee and team:
    totals, late count, absence count (excluding weekends and holidays),
    verified presence minutes, and overtime calculations.
    """
    try:
        report = generate_timesheet_report(
            date=date,
            start_date=start_date,
            end_date=end_date,
            employee_id=employee_id,
            department=department,
            period=period
        )
        return report
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


# ---------------------------------------------------------------------------
# Payroll Management: Pay Periods, Lock & Approval, Exports
# ---------------------------------------------------------------------------

@router.get("/payroll/periods", dependencies=[Depends(require_admin)])
def list_payroll_periods():
    """List all pay periods and their review/locked status."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM payroll_periods ORDER BY start_date DESC")
    rows = cursor.fetchall()
    conn.close()
    return [PayrollPeriodModel.to_dict(r) for r in rows]


@router.post("/payroll/periods", dependencies=[Depends(require_admin)])
def create_payroll_period(payload: PayrollPeriodCreate):
    """Create a new payroll period for manager review."""
    validate_date(payload.start_date, "start_date")
    validate_date(payload.end_date, "end_date")
    if payload.start_date > payload.end_date:
        raise HTTPException(status_code=422, detail="start_date cannot be after end_date")

    now = get_now().isoformat()
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("""
        INSERT INTO payroll_periods (name, start_date, end_date, status, notes, created_at)
        VALUES (?, ?, ?, 'OPEN', ?, ?)
    """, (payload.name.strip(), payload.start_date, payload.end_date, payload.notes, now))
    conn.commit()
    new_id = cursor.lastrowid
    cursor.execute("SELECT * FROM payroll_periods WHERE id = ?", (new_id,))
    row = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": f"Pay period '{payload.name}' created.",
        "period": PayrollPeriodModel.to_dict(row)
    }


@router.post("/payroll/periods/{period_id}/approve", dependencies=[Depends(require_admin)])
def approve_payroll_period(period_id: int):
    """Approve a pay period following manager review."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM payroll_periods WHERE id = ?", (period_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Payroll period not found")

    now = get_now().isoformat()
    cursor.execute("""
        UPDATE payroll_periods
        SET status = 'APPROVED', approved_by = 'Management', approved_at = ?
        WHERE id = ?
    """, (now, period_id))
    conn.commit()

    cursor.execute("SELECT * FROM payroll_periods WHERE id = ?", (period_id,))
    updated = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": f"Pay period '{updated['name']}' approved.",
        "period": PayrollPeriodModel.to_dict(updated)
    }


@router.post("/payroll/periods/{period_id}/lock", dependencies=[Depends(require_admin)])
def lock_payroll_period(period_id: int):
    """Lock a pay period so later edits cannot change paid figures."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM payroll_periods WHERE id = ?", (period_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Payroll period not found")

    now = get_now().isoformat()
    cursor.execute("""
        UPDATE payroll_periods
        SET status = 'LOCKED', locked_at = ?, approved_at = COALESCE(approved_at, ?)
        WHERE id = ?
    """, (now, now, period_id))
    conn.commit()

    cursor.execute("SELECT * FROM payroll_periods WHERE id = ?", (period_id,))
    updated = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": f"Pay period '{updated['name']}' is now locked. Further attendance modifications for this period are prohibited.",
        "period": PayrollPeriodModel.to_dict(updated)
    }


@router.post("/payroll/periods/{period_id}/unlock", dependencies=[Depends(require_admin)])
def unlock_payroll_period(period_id: int):
    """Unlock a pay period (administrative exception)."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM payroll_periods WHERE id = ?", (period_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Payroll period not found")

    cursor.execute("""
        UPDATE payroll_periods
        SET status = 'OPEN', locked_at = NULL
        WHERE id = ?
    """, (period_id,))
    conn.commit()

    cursor.execute("SELECT * FROM payroll_periods WHERE id = ?", (period_id,))
    updated = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": f"Pay period '{updated['name']}' unlocked.",
        "period": PayrollPeriodModel.to_dict(updated)
    }


@router.get("/payroll/summary", dependencies=[Depends(require_admin)])
def get_payroll_summary(
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    period_id: Optional[int] = Query(None),
):
    """Retrieve summary metrics for payroll review."""
    start = start_date
    end = end_date

    if period_id:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM payroll_periods WHERE id = ?", (period_id,))
        p = cursor.fetchone()
        conn.close()
        if p:
            start = p["start_date"]
            end = p["end_date"]

    if not start or not end:
        today = get_today_str()
        anchor = datetime.strptime(today, DATE_FORMAT)
        start = anchor.replace(day=1).strftime(DATE_FORMAT)
        end = today

    _rows, summary = generate_payroll_export_data(start, end)
    return {
        "start_date": start,
        "end_date": end,
        "summary": summary
    }


@router.get("/payroll/export", dependencies=[Depends(require_admin)])
def export_payroll(
    start_date: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end_date: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    period_id: Optional[int] = Query(None, description="ID of pay period to export"),
    format: str = Query("csv", description="'csv' or 'xlsx'"),
    employee_id: Optional[int] = Query(None),
    department: Optional[str] = Query(None)
):
    """
    Download payroll export as CSV or XLSX.
    One row per employee-day (staff id, date, in, out, worked, break, overtime, late, presence status)
    plus a period summary reconciles directly with timesheets.
    """
    start = start_date
    end = end_date

    if period_id:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM payroll_periods WHERE id = ?", (period_id,))
        p = cursor.fetchone()
        conn.close()
        if p:
            start = p["start_date"]
            end = p["end_date"]

    if not start or not end:
        today = get_today_str()
        anchor = datetime.strptime(today, DATE_FORMAT)
        start = anchor.replace(day=1).strftime(DATE_FORMAT)
        end = today

    fmt = format.lower().strip()
    if fmt == "xlsx":
        xlsx_bytes = export_payroll_xlsx(
            start, end, employee_id=employee_id, department=department
        )
        filename = f"payroll_export_{start}_to_{end}.xlsx"
        return Response(
            content=xlsx_bytes,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )
    else:
        # Default to CSV
        filename = f"payroll_export_{start}_to_{end}.csv"
        return StreamingResponse(
            stream_payroll_csv(start, end, employee_id=employee_id, department=department),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )
