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
from backend.models import GeofenceModel, AttendanceModel
from backend.routers.auth import require_admin
from backend.schemas import GeofenceUpdate
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
        cursor.execute("""
            INSERT INTO attendance_records (
                employee_id, date, clock_in_time, clock_in_lat, clock_in_lon,
                clock_in_distance, clock_out_time, clock_out_lat, clock_out_lon,
                clock_out_distance, status, is_late, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            emp_id, today_str, cfg[0], cfg[1], cfg[2],
            cfg[3], cfg[4], cfg[5], cfg[6], cfg[7], cfg[8], cfg[9], cfg[10]
        ))

    conn.commit()
    conn.close()

    return {"status": "success", "message": f"Sample attendance records seeded across all {len(employees)} employees for today!"}
