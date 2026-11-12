from fastapi import APIRouter, HTTPException, status, Query, Depends
from typing import Optional

from backend.database import get_db
from backend.config import get_now, get_today_str, get_current_time_str
from backend.schemas import ClockInRequest, ClockOutRequest, BreakCreate
from backend.services.geofence import verify_geofence
from backend.models import AttendanceModel
from backend.routers.auth import require_employee
from backend.services.schedules import (
    get_employee_schedule_for_date,
    is_working_day,
    calculate_punctuality,
    calculate_shift_duration,
    is_period_locked,
    format_minutes_to_hours_mins,
)

router = APIRouter(prefix="/api/attendance", tags=["Attendance"])

ACCURACY_MESSAGES = {
    "ACCURACY_MISSING": "Your device did not report a GPS accuracy value, so your location cannot be verified. Enable precise location and try again.",
    "ACCURACY_TOO_LOW": "Your GPS signal is too imprecise to verify your location. Step outside or near a window and try again.",
}


def _latest_geofence(cursor):
    cursor.execute("SELECT * FROM geofence_settings ORDER BY id DESC LIMIT 1")
    return cursor.fetchone()


def _reject_location(geo_check):
    """Raise the 403 that matches a failed geofence/accuracy check."""
    reason = geo_check.get("reason")
    if reason in ACCURACY_MESSAGES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": reason,
                "message": ACCURACY_MESSAGES[reason],
                "gps_accuracy_meters": geo_check.get("gps_accuracy_meters"),
                "max_allowed_accuracy_meters": geo_check.get("max_allowed_accuracy_meters"),
            },
        )
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "error": "OUTSIDE_GEOFENCE",
            "message": f"You are outside the workplace perimeter. You are {geo_check['distance_meters']}m away (Allowed radius: {geo_check['allowed_radius_meters']}m).",
            "distance_meters": geo_check["distance_meters"],
            "allowed_radius_meters": geo_check["allowed_radius_meters"],
            "gps_accuracy_meters": geo_check.get("gps_accuracy_meters"),
        },
    )


@router.post("/clock-in")
def clock_in(payload: ClockInRequest, employee_id: int = Depends(require_employee)):
    """
    Validate GPS location against the active workplace geofence and record
    clock-in for the authenticated employee.
    """
    conn = get_db()
    cursor = conn.cursor()

    # 1. Verify Employee Exists
    cursor.execute("SELECT * FROM employees WHERE id = ?", (employee_id,))
    employee = cursor.fetchone()
    if not employee:
        conn.close()
        raise HTTPException(status_code=404, detail="Employee not found")

    # 2. Retrieve Active Workplace Geofence
    geofence = _latest_geofence(cursor)
    if not geofence:
        conn.close()
        raise HTTPException(status_code=500, detail="Workplace geofence settings not configured")

    # 3. Calculate Geofence Distance (accuracy is enforced server-side)
    try:
        geo_check = verify_geofence(
            user_lat=payload.latitude,
            user_lon=payload.longitude,
            office_lat=geofence["latitude"],
            office_lon=geofence["longitude"],
            allowed_radius=geofence["radius_meters"],
            gps_accuracy=payload.accuracy,
        )
    except Exception:
        conn.close()
        raise

    if not geo_check["is_inside"]:
        conn.close()
        _reject_location(geo_check)

    # 4. Check If Already Clocked In Today
    today_str = get_today_str()

    # 4a. Check If Pay Period Is Locked
    locked, lock_info = is_period_locked(cursor, today_str)
    if locked:
        conn.close()
        raise HTTPException(
            status_code=403,
            detail=f"Attendance recording is blocked: pay period '{lock_info['name']}' is approved and locked by management."
        )

    cursor.execute(
        """
        SELECT * FROM attendance_records
        WHERE employee_id = ? AND date = ?
        """,
        (employee_id, today_str),
    )
    existing = cursor.fetchone()

    if existing:
        conn.close()
        if existing["status"] == "CLOCKED_IN":
            raise HTTPException(status_code=400, detail="You are already clocked in for today.")
        raise HTTPException(status_code=400, detail="Shift already completed for today.")

    # 5. Determine Late Arrival against employee's schedule for today
    now = get_now()
    current_time_str = get_current_time_str()
    started_at_iso = now.isoformat()
    schedule = get_employee_schedule_for_date(cursor, employee_id, today_str)
    is_late, late_mins, punctuality_note = calculate_punctuality(schedule, now, today_str)

    # 6. Insert Attendance Record
    cursor.execute(
        """
        INSERT INTO attendance_records (
            employee_id, date, clock_in_time, clock_in_lat, clock_in_lon,
            clock_in_distance, status, is_late, notes, started_at, schedule_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            employee_id,
            today_str,
            current_time_str,
            payload.latitude,
            payload.longitude,
            geo_check["distance_meters"],
            "CLOCKED_IN",
            is_late,
            f"Arrived within geofence perimeter. {punctuality_note}",
            started_at_iso,
            schedule.get("id"),
        ),
    )
    conn.commit()
    new_record_id = cursor.lastrowid

    cursor.execute(
        """
        SELECT a.*, e.name, e.department, e.staff_id, s.name AS schedule_name
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
        LEFT JOIN schedules s ON a.schedule_id = s.id
        WHERE a.id = ?
        """,
        (new_record_id,),
    )
    created_record = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": "Successfully clocked in! Arrival recorded.",
        "record": AttendanceModel.to_dict(created_record),
        "geofence": geo_check,
        "schedule": schedule,
    }


@router.post("/clock-out")
def clock_out(payload: ClockOutRequest, employee_id: int = Depends(require_employee)):
    """
    Record departure for the authenticated employee. GPS accuracy is enforced and
    the distance is stored; whether clock-out must be inside the fence is a policy
    decision tracked separately.
    """
    conn = get_db()
    cursor = conn.cursor()

    # 1. Find today's active shift
    today_str = get_today_str()
    cursor.execute(
        """
        SELECT * FROM attendance_records
        WHERE employee_id = ? AND date = ?
        """,
        (employee_id, today_str),
    )
    record = cursor.fetchone()

    if not record:
        conn.close()
        raise HTTPException(status_code=400, detail="No clock-in record found for today. Please clock in first.")

    if record["status"] == "CLOCKED_OUT":
        conn.close()
        raise HTTPException(status_code=400, detail="You have already clocked out for today.")

    # Check if target date is in a locked pay period
    locked, lock_info = is_period_locked(cursor, record["date"])
    if locked:
        conn.close()
        raise HTTPException(
            status_code=403,
            detail=f"Shift completion is blocked: pay period '{lock_info['name']}' is approved and locked by management."
        )

    # 2. Retrieve Geofence for Distance Measurement
    geofence = _latest_geofence(cursor)
    if not geofence:
        conn.close()
        raise HTTPException(status_code=500, detail="Workplace geofence settings not configured")

    geo_check = verify_geofence(
        user_lat=payload.latitude,
        user_lon=payload.longitude,
        office_lat=geofence["latitude"],
        office_lon=geofence["longitude"],
        allowed_radius=geofence["radius_meters"],
        gps_accuracy=payload.accuracy,
    )

    # A fix with no usable accuracy cannot be recorded as verified presence.
    if geo_check["reason"] in ACCURACY_MESSAGES:
        conn.close()
        _reject_location(geo_check)

    # 3. Calculate shift duration, breaks, and overtime
    now = get_now()
    now_time = get_current_time_str()
    ended_at_iso = now.isoformat()
    schedule = get_employee_schedule_for_date(cursor, employee_id, record["date"])

    # Fetch explicit breaks if any
    cursor.execute("SELECT SUM(break_minutes) FROM breaks WHERE attendance_id = ? AND is_paid = 0", (record["id"],))
    break_row = cursor.fetchone()
    explicit_break = break_row[0] if break_row and break_row[0] else 0

    started_val = record["started_at"] or f"{record['date']}T{record['clock_in_time']}"
    duration_res = calculate_shift_duration(started_val, ended_at_iso, schedule, explicit_break)

    cursor.execute(
        """
        UPDATE attendance_records
        SET clock_out_time = ?,
            clock_out_lat = ?,
            clock_out_lon = ?,
            clock_out_distance = ?,
            status = 'CLOCKED_OUT',
            ended_at = ?,
            worked_minutes = ?,
            break_minutes = ?,
            overtime_minutes = ?
        WHERE id = ?
        """,
        (
            now_time,
            payload.latitude,
            payload.longitude,
            geo_check["distance_meters"],
            ended_at_iso,
            duration_res["worked_minutes"],
            duration_res["break_minutes"],
            duration_res["overtime_minutes"],
            record["id"],
        ),
    )
    conn.commit()

    cursor.execute(
        """
        SELECT a.*, e.name, e.department, e.staff_id, s.name AS schedule_name
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
        LEFT JOIN schedules s ON a.schedule_id = s.id
        WHERE a.id = ?
        """,
        (record["id"],),
    )
    updated_record = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": f"Successfully clocked out! Departure recorded. {duration_res['worked_display']} worked.",
        "record": AttendanceModel.to_dict(updated_record),
        "geofence": geo_check,
        "duration": duration_res,
    }


@router.get("/status/{employee_id}")
def get_daily_status(
    employee_id: int,
    date: Optional[str] = Query(None),
    authenticated_employee_id: int = Depends(require_employee),
):
    """Return clock-in status, worked hours, and schedule for the authenticated employee only."""
    if employee_id != authenticated_employee_id:
        raise HTTPException(status_code=403, detail="You may only view your own attendance status.")

    conn = get_db()
    cursor = conn.cursor()
    query_date = date.strip() if date else get_today_str()

    cursor.execute(
        """
        SELECT a.*, e.name, e.department, e.staff_id, s.name AS schedule_name
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
        LEFT JOIN schedules s ON a.schedule_id = s.id
        WHERE a.employee_id = ? AND a.date = ?
        ORDER BY a.id DESC
        LIMIT 1
        """,
        (employee_id, query_date),
    )
    record = cursor.fetchone()

    schedule = get_employee_schedule_for_date(cursor, employee_id, query_date)
    is_work, work_reason = is_working_day(cursor, employee_id, query_date)
    conn.close()

    worked_mins = 0
    worked_display = "You worked 0 h 0 m today"

    if record:
        if record["status"] == "CLOCKED_OUT":
            worked_mins = record["worked_minutes"] or 0
            hours = worked_mins // 60
            mins = worked_mins % 60
            worked_display = f"You worked {hours} h {mins} m today"
        elif record["status"] == "CLOCKED_IN":
            started_val = record["started_at"] or f"{record['date']}T{record['clock_in_time']}"
            cur_dur = calculate_shift_duration(started_val, get_now(), schedule, 0)
            worked_mins = cur_dur["worked_minutes"]
            hours = worked_mins // 60
            mins = worked_mins % 60
            worked_display = f"Shift in progress ({hours} h {mins} m worked so far)"

        return {
            "status": record["status"],
            "date": query_date,
            "record": AttendanceModel.to_dict(record),
            "worked_minutes": worked_mins,
            "worked_time_display": worked_display,
            "schedule": {
                "id": schedule.get("id"),
                "name": schedule.get("name"),
                "start": schedule.get("start_time"),
                "start_time": schedule.get("start_time"),
                "end": schedule.get("end_time"),
                "end_time": schedule.get("end_time"),
                "grace_minutes": schedule.get("grace_minutes"),
                "break_minutes": schedule.get("break_minutes"),
            },
            "is_working_day": is_work,
            "working_day_reason": work_reason,
        }

    return {
        "status": "NOT_CLOCKED_IN",
        "date": query_date,
        "record": None,
        "worked_minutes": 0,
        "worked_time_display": "You worked 0 h 0 m today",
        "schedule": {
            "id": schedule.get("id"),
            "name": schedule.get("name"),
            "start": schedule.get("start_time"),
            "start_time": schedule.get("start_time"),
            "end": schedule.get("end_time"),
            "end_time": schedule.get("end_time"),
            "grace_minutes": schedule.get("grace_minutes"),
            "break_minutes": schedule.get("break_minutes"),
        },
        "is_working_day": is_work,
        "working_day_reason": work_reason,
    }


@router.get("/history/{employee_id}")
def get_employee_history(
    employee_id: int,
    limit: int = 10,
    authenticated_employee_id: int = Depends(require_employee),
):
    """Retrieve recent attendance history for the authenticated employee only."""
    if employee_id != authenticated_employee_id:
        raise HTTPException(status_code=403, detail="You may only view your own attendance history.")

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT a.*, e.name, e.department, e.staff_id
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
        WHERE a.employee_id = ?
        ORDER BY a.date DESC, a.id DESC
        LIMIT ?
        """,
        (employee_id, limit),
    )
    rows = cursor.fetchall()
    conn.close()

    return [AttendanceModel.to_dict(row) for row in rows]


@router.post("/break")
def record_break(
    payload: BreakCreate,
    employee_id: int = Depends(require_employee)
):
    """Explicitly record a break for today's active shift."""
    conn = get_db()
    cursor = conn.cursor()
    today_str = get_today_str()

    cursor.execute("""
        SELECT * FROM attendance_records
        WHERE employee_id = ? AND date = ?
    """, (employee_id, today_str))
    record = cursor.fetchone()
    if not record:
        conn.close()
        raise HTTPException(status_code=400, detail="No active shift found for today. Clock in first.")

    now_iso = get_now().isoformat()
    cursor.execute("""
        INSERT INTO breaks (attendance_id, break_start, break_minutes, is_paid, created_at)
        VALUES (?, ?, ?, ?, ?)
    """, (record["id"], now_iso, payload.break_minutes, payload.is_paid or 0, now_iso))
    conn.commit()
    conn.close()

    return {
        "status": "success",
        "message": f"Recorded {payload.break_minutes} min break ({'paid' if payload.is_paid else 'unpaid'})."
    }
