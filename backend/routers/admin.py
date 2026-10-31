from fastapi import APIRouter, HTTPException, Response, Query, Header, Depends
from datetime import datetime, timedelta
from typing import Optional
from backend.config import ADMIN_PIN
from backend.database import get_db
from backend.models import GeofenceModel, AttendanceModel
from backend.schemas import GeofenceUpdate, AdminLogin
from backend.services.reports import generate_daily_report, export_attendance_csv

router = APIRouter(prefix="/api/admin", tags=["Admin"])

def require_admin_pin(x_admin_pin: Optional[str] = Header(default=None)):
    """Gate sensitive admin routes behind the X-Admin-Pin header"""
    if x_admin_pin != ADMIN_PIN:
        raise HTTPException(status_code=401, detail="Invalid or missing admin PIN")

@router.post("/login")
def admin_login(payload: AdminLogin):
    """Verify admin PIN before unlocking the dashboard"""
    if payload.pin != ADMIN_PIN:
        raise HTTPException(status_code=401, detail="Incorrect PIN. Access denied.")
    return {"status": "success", "message": "Admin session verified"}

@router.get("/geofence")
def get_geofence():
    """Retrieve current active workplace geofence coordinates and radius (open: employee portal consumes this)"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM geofence_settings ORDER BY id DESC LIMIT 1")
    row = cursor.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="No geofence settings configured")

    return GeofenceModel.to_dict(row)

@router.put("/geofence", dependencies=[Depends(require_admin_pin)])
def update_geofence(payload: GeofenceUpdate):
    """Update active workplace coordinates and allowed radius"""
    conn = get_db()
    cursor = conn.cursor()
    now = datetime.now().isoformat()

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
        payload.work_start_time or "09:00",
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

@router.get("/metrics", dependencies=[Depends(require_admin_pin)])
def get_admin_metrics(date: Optional[str] = None):
    """Retrieve daily summary KPIs for admin dashboard"""
    return generate_daily_report(date)

@router.get("/records", dependencies=[Depends(require_admin_pin)])
def get_attendance_records(date: Optional[str] = None, employee_id: Optional[int] = None):
    """Retrieve all attendance records with optional date or employee filters"""
    conn = get_db()
    cursor = conn.cursor()

    query = """
        SELECT a.*, e.name, e.department, e.staff_id
        FROM attendance_records a
        JOIN employees e ON a.employee_id = e.id
        WHERE 1=1
    """
    params = []

    if date:
        query += " AND a.date = ?"
        params.append(date)

    if employee_id:
        query += " AND a.employee_id = ?"
        params.append(employee_id)

    query += " ORDER BY a.date DESC, a.clock_in_time DESC"

    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    conn.close()

    return [AttendanceModel.to_dict(row) for row in rows]

@router.get("/export/csv", dependencies=[Depends(require_admin_pin)])
def download_attendance_csv(date: Optional[str] = None):
    """Download attendance log formatted as CSV"""
    csv_content = export_attendance_csv(date)
    filename = f"attendance_report_{date or 'all'}.csv"

    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

@router.post("/seed-demo-data", dependencies=[Depends(require_admin_pin)])
def seed_demo_data():
    """Populates realistic sample attendance records across team members for demonstration"""
    conn = get_db()
    cursor = conn.cursor()

    # Get sample employees
    cursor.execute("SELECT id FROM employees LIMIT 6")
    employees = cursor.fetchall()

    today_str = datetime.now().strftime("%Y-%m-%d")
    yesterday_str = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

    cursor.execute("SELECT latitude, longitude FROM geofence_settings LIMIT 1")
    geo = cursor.fetchone()
    lat = geo["latitude"] if geo else 6.5244
    lon = geo["longitude"] if geo else 3.3792

    demo_records = [
        (employees[0][0], today_str, "08:42:15", lat + 0.0001, lon + 0.0001, 14.5, "17:02:10", lat, lon, 18.2, "CLOCKED_OUT", 0, "On time"),
        (employees[1][0], today_str, "08:55:00", lat, lon, 8.3, None, None, None, None, "CLOCKED_IN", 0, "Present"),
        (employees[2][0], today_str, "09:18:22", lat + 0.0003, lon - 0.0002, 38.6, None, None, None, None, "CLOCKED_IN", 1, "Late arrival (Traffic)"),
        (employees[3][0], yesterday_str, "08:30:10", lat, lon, 12.0, "17:15:00", lat, lon, 15.0, "CLOCKED_OUT", 0, "Completed"),
        (employees[4][0], yesterday_str, "09:05:44", lat, lon, 22.1, "16:55:12", lat, lon, 25.4, "CLOCKED_OUT", 1, "Late arrival"),
    ]

    for rec in demo_records:
        cursor.execute("""
            INSERT INTO attendance_records (
                employee_id, date, clock_in_time, clock_in_lat, clock_in_lon,
                clock_in_distance, clock_out_time, clock_out_lat, clock_out_lon,
                clock_out_distance, status, is_late, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, rec)

    now_iso = datetime.now().isoformat()
    demo_attempts = [
        (employees[5][0] if len(employees) > 5 else employees[0][0], today_str, now_iso,
         lat + 0.01, lon - 0.008, 1250.0, 150.0),
        (employees[4][0] if len(employees) > 4 else employees[0][0], today_str, now_iso,
         lat - 0.006, lon + 0.007, 930.0, 150.0),
    ]

    for attempt in demo_attempts:
        cursor.execute("""
            INSERT INTO boundary_attempts (
                employee_id, date, attempted_at, latitude, longitude,
                distance_meters, allowed_radius_meters
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """, attempt)

    conn.commit()
    conn.close()

    return {"status": "success", "message": "Demo attendance data seeded successfully"}
