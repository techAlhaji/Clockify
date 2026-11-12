from fastapi import APIRouter, HTTPException, status, Query, Depends
from typing import Optional

from backend.database import get_db
from backend.config import get_now, get_today_str, get_current_time_str
from backend.schemas import ClockInRequest, ClockOutRequest
from backend.services.geofence import verify_geofence
from backend.models import AttendanceModel
from backend.routers.auth import require_employee

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

    # 5. Determine Late Arrival (Evaluated in Local Workplace Timezone)
    now = get_now()
    current_time_str = get_current_time_str()
    start_time_str = geofence["work_start_time"] or "09:00"

    try:
        start_hour, start_minute = map(int, start_time_str.split(":")[:2])
    except Exception:
        start_hour, start_minute = (9, 0)
    is_late = 1 if (now.hour, now.minute) > (start_hour, start_minute) else 0

    # 6. Insert Attendance Record
    cursor.execute(
        """
        INSERT INTO attendance_records (
            employee_id, date, clock_in_time, clock_in_lat, clock_in_lon,
            clock_in_distance, status, is_late, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            "Arrived within geofence perimeter",
        ),
    )
    conn.commit()
    new_record_id = cursor.lastrowid

    cursor.execute(
        """
        SELECT a.*, e.name, e.department, e.staff_id
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
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

    # 3. Update Record with Clock Out Details
    now_time = get_current_time_str()
    cursor.execute(
        """
        UPDATE attendance_records
        SET clock_out_time = ?,
            clock_out_lat = ?,
            clock_out_lon = ?,
            clock_out_distance = ?,
            status = 'CLOCKED_OUT'
        WHERE id = ?
        """,
        (now_time, payload.latitude, payload.longitude, geo_check["distance_meters"], record["id"]),
    )
    conn.commit()

    cursor.execute(
        """
        SELECT a.*, e.name, e.department, e.staff_id
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
        WHERE a.id = ?
        """,
        (record["id"],),
    )
    updated_record = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": "Successfully clocked out! Departure recorded.",
        "record": AttendanceModel.to_dict(updated_record),
        "geofence": geo_check,
    }


@router.get("/status/{employee_id}")
def get_daily_status(
    employee_id: int,
    date: Optional[str] = Query(None),
    authenticated_employee_id: int = Depends(require_employee),
):
    """Return clock-in status for the authenticated employee only."""
    if employee_id != authenticated_employee_id:
        raise HTTPException(status_code=403, detail="You may only view your own attendance status.")

    conn = get_db()
    cursor = conn.cursor()
    query_date = date.strip() if date else get_today_str()

    cursor.execute(
        """
        SELECT a.*, e.name, e.department, e.staff_id
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
        WHERE a.employee_id = ? AND a.date = ?
        ORDER BY a.id DESC
        LIMIT 1
        """,
        (employee_id, query_date),
    )
    record = cursor.fetchone()
    conn.close()

    if not record:
        return {"status": "NOT_CLOCKED_IN", "date": query_date, "record": None}

    return {
        "status": record["status"],
        "date": query_date,
        "record": AttendanceModel.to_dict(record),
    }


@router.get("/history/{employee_id}")
def get_employee_history(
    employee_id: int,
    limit: int = Query(10, ge=1, le=100),
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
