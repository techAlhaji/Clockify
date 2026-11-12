from fastapi import APIRouter, HTTPException
from datetime import datetime
from backend.config import get_now
from backend.database import get_db
from backend.models import EmployeeModel
from backend.schemas import EmployeeCreate
from backend.security import hash_pin

router = APIRouter(prefix="/api/employees", tags=["Employees"])

@router.get("")
def list_employees():
    """Returns a list of all active employees"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM employees ORDER BY name ASC")
    rows = cursor.fetchall()
    conn.close()
    return [EmployeeModel.to_dict(row) for row in rows]

@router.get("/{employee_id}")
def get_employee(employee_id: int):
    """Retrieve details for a single employee"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM employees WHERE id = ?", (employee_id,))
    row = cursor.fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Employee not found")
    return EmployeeModel.to_dict(row)

@router.post("")
def create_employee(payload: EmployeeCreate):
    """Register a new employee into the system"""
    if not payload.pin.isdigit() or not (4 <= len(payload.pin) <= 8):
        raise HTTPException(status_code=422, detail="PIN must be 4-8 digits.")

    conn = get_db()
    cursor = conn.cursor()
    try:
        now = get_now().isoformat()
        cursor.execute("""
            INSERT INTO employees (staff_id, name, email, department, pin, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (payload.staff_id, payload.name, payload.email, payload.department, hash_pin(payload.pin), now))
        conn.commit()
        new_id = cursor.lastrowid
        cursor.execute("SELECT * FROM employees WHERE id = ?", (new_id,))
        new_emp = cursor.fetchone()
        conn.close()
        return EmployeeModel.to_dict(new_emp)
    except Exception as e:
        conn.close()
        raise HTTPException(status_code=400, detail=f"Failed to create employee: {str(e)}")
