from fastapi import APIRouter, HTTPException, status, Query
from datetime import datetime
from typing import Optional
from backend.database import get_db
from backend.config import get_now, get_today_str, get_current_time_str
from backend.schemas import ClockInRequest, ClockOutRequest, SyncShiftRequest
from backend.services.geofence import verify_geofence
from backend.models import AttendanceModel

router = APIRouter(prefix="/api/attendance", tags=["Attendance"])

@router.post("/clock-in")
def clock_in(payload: ClockInRequest):
    """
    Validates GPS location against the active workplace geofence 
    and logs attendance clock-in time.
    """
    conn = get_db()
    cursor = conn.cursor()

    # 1. Verify Employee Exists
    cursor.execute("SELECT * FROM employees WHERE id = ?", (payload.employee_id,))
    employee = cursor.fetchone()
    if not employee:
        conn.close()
        raise HTTPException(status_code=404, detail="Employee not found")

    # 2. Retrieve Active Workplace Geofence
    cursor.execute("SELECT * FROM geofence_settings ORDER BY id DESC LIMIT 1")
    geofence = cursor.fetchone()
    if not geofence:
        conn.close()
        raise HTTPException(status_code=500, detail="Workplace geofence settings not configured")

    # 3. Calculate Geofence Distance
    geo_check = verify_geofence(
        user_lat=payload.latitude,
        user_lon=payload.longitude,
        office_lat=geofence["latitude"],
        office_lon=geofence["longitude"],
        allowed_radius=geofence["radius_meters"],
        gps_accuracy=payload.accuracy
    )

    if not geo_check["is_inside"]:
        conn.close()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "OUTSIDE_GEOFENCE",
                "message": f"You are outside the workplace perimeter. You are {geo_check['distance_meters']}m away (Allowed radius: {geo_check['allowed_radius_meters']}m).",
                "distance_meters": geo_check["distance_meters"],
                "allowed_radius_meters": geo_check["allowed_radius_meters"]
            }
        )

    # 4. Check If Already Clocked In Today
    today_str = get_today_str()
    cursor.execute("""
        SELECT * FROM attendance_records 
        WHERE employee_id = ? AND date = ?
    """, (payload.employee_id, today_str))
    existing = cursor.fetchone()

    if existing:
        conn.close()
        if existing["status"] == "CLOCKED_IN":
            raise HTTPException(status_code=400, detail="You are already clocked in for today.")
        else:
            raise HTTPException(status_code=400, detail="Shift already completed for today.")

    # 5. Determine Late Arrival (Evaluated in Local Workplace Timezone)
    now = get_now()
    current_time_str = get_current_time_str()
    start_time_str = geofence["work_start_time"] or "09:00"
    
    # Check if arrival is after start time (HH:MM)
    try:
        start_hour, start_minute = map(int, start_time_str.split(":")[:2])
    except Exception:
        start_hour, start_minute = (9, 0)
    is_late = 1 if (now.hour, now.minute) > (start_hour, start_minute) else 0

    # 6. Insert Attendance Record
    cursor.execute("""
        INSERT INTO attendance_records (
            employee_id, date, clock_in_time, clock_in_lat, clock_in_lon,
            clock_in_distance, status, is_late, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        payload.employee_id,
        today_str,
        current_time_str,
        payload.latitude,
        payload.longitude,
        geo_check["distance_meters"],
        "CLOCKED_IN",
        is_late,
        "Arrived within geofence perimeter"
    ))
    conn.commit()
    new_record_id = cursor.lastrowid

    cursor.execute("""
        SELECT a.*, e.name, e.department, e.staff_id
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
        WHERE a.id = ?
    """, (new_record_id,))
    created_record = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": "Successfully clocked in! Arrival recorded.",
        "record": AttendanceModel.to_dict(created_record),
        "geofence": geo_check
    }

@router.post("/clock-out")
def clock_out(payload: ClockOutRequest):
    """
    Records employee departure time and marks shift completed.
    """
    conn = get_db()
    cursor = conn.cursor()

    # 1. Find today's active shift
    today_str = get_today_str()
    cursor.execute("""
        SELECT * FROM attendance_records 
        WHERE employee_id = ? AND date = ?
    """, (payload.employee_id, today_str))
    record = cursor.fetchone()

    if not record:
        conn.close()
        raise HTTPException(status_code=400, detail="No clock-in record found for today. Please clock in first.")

    if record["status"] == "CLOCKED_OUT":
        conn.close()
        raise HTTPException(status_code=400, detail="You have already clocked out for today.")

    # 2. Retrieve Geofence for Distance Measurement
    cursor.execute("SELECT * FROM geofence_settings ORDER BY id DESC LIMIT 1")
    geofence = cursor.fetchone()
    
    geo_check = verify_geofence(
        user_lat=payload.latitude,
        user_lon=payload.longitude,
        office_lat=geofence["latitude"],
        office_lon=geofence["longitude"],
        allowed_radius=geofence["radius_meters"],
        gps_accuracy=payload.accuracy
    )

    # 3. Update Record with Clock Out Details
    now_time = get_current_time_str()
    cursor.execute("""
        UPDATE attendance_records
        SET clock_out_time = ?,
            clock_out_lat = ?,
            clock_out_lon = ?,
            clock_out_distance = ?,
            status = 'CLOCKED_OUT'
        WHERE id = ?
    """, (now_time, payload.latitude, payload.longitude, geo_check["distance_meters"], record["id"]))
    conn.commit()

    cursor.execute("""
        SELECT a.*, e.name, e.department, e.staff_id
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
        WHERE a.id = ?
    """, (record["id"],))
    updated_record = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": "Successfully clocked out! Departure recorded.",
        "record": AttendanceModel.to_dict(updated_record),
        "geofence": geo_check
    }

@router.get("/status/{employee_id}")
def get_daily_status(employee_id: int, date: Optional[str] = Query(None)):
    """
    Returns today's clock-in status for the specified employee.
    """
    conn = get_db()
    cursor = conn.cursor()
    query_date = date.strip() if date else get_today_str()

    cursor.execute("""
        SELECT a.*, e.name, e.department, e.staff_id
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
        WHERE a.employee_id = ? AND a.date = ?
        ORDER BY a.id DESC
        LIMIT 1
    """, (employee_id, query_date))
    record = cursor.fetchone()
    conn.close()

    if not record:
        return {
            "status": "NOT_CLOCKED_IN",
            "date": query_date,
            "record": None
        }

    return {
        "status": record["status"],
        "date": query_date,
        "record": AttendanceModel.to_dict(record)
    }

@router.post("/sync-shift")
def sync_shift(payload: SyncShiftRequest):
    """
    Syncs or restores an attendance record from client storage into the database.
    Ensures that attendance records persist across serverless instances and reboots.
    """
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT id, status FROM attendance_records
        WHERE employee_id = ? AND date = ?
    """, (payload.employee_id, payload.date))
    existing = cursor.fetchone()

    if existing:
        cursor.execute("""
            UPDATE attendance_records
            SET clock_out_time = COALESCE(?, clock_out_time),
                clock_out_lat = COALESCE(?, clock_out_lat),
                clock_out_lon = COALESCE(?, clock_out_lon),
                clock_out_distance = COALESCE(?, clock_out_distance),
                status = ?,
                notes = COALESCE(?, notes)
            WHERE id = ?
        """, (
            payload.clock_out_time,
            payload.clock_out_lat,
            payload.clock_out_lon,
            payload.clock_out_distance,
            payload.status,
            payload.notes,
            existing["id"]
        ))
        conn.commit()
        record_id = existing["id"]
    else:
        cursor.execute("""
            INSERT INTO attendance_records (
                employee_id, date, clock_in_time, clock_in_lat, clock_in_lon,
                clock_in_distance, clock_out_time, clock_out_lat, clock_out_lon,
                clock_out_distance, status, is_late, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            payload.employee_id,
            payload.date,
            payload.clock_in_time,
            payload.clock_in_lat,
            payload.clock_in_lon,
            payload.clock_in_distance,
            payload.clock_out_time,
            payload.clock_out_lat,
            payload.clock_out_lon,
            payload.clock_out_distance,
            payload.status,
            1 if payload.is_late else 0,
            payload.notes or "Synchronized record"
        ))
        conn.commit()
        record_id = cursor.lastrowid

    cursor.execute("""
        SELECT a.*, e.name, e.department, e.staff_id
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
        WHERE a.id = ?
    """, (record_id,))
    rec = cursor.fetchone()
    conn.close()

    return {
        "status": "success",
        "message": "Shift record synchronized successfully",
        "record": AttendanceModel.to_dict(rec)
    }


@router.get("/history/{employee_id}")
def get_employee_history(employee_id: int, limit: int = 10):
    """
    Retrieves recent attendance history for the specified employee.
    """
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT a.*, e.name, e.department, e.staff_id
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
        WHERE a.employee_id = ?
        ORDER BY a.date DESC, a.id DESC
        LIMIT ?
    """, (employee_id, limit))
    rows = cursor.fetchall()
    conn.close()

    return [AttendanceModel.to_dict(row) for row in rows]
