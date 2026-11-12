from fastapi import APIRouter, HTTPException, Header, Depends
from typing import Optional

from backend.database import get_db
from backend.schemas import PinVerification, AdminLoginRequest, EmployeeLoginRequest
from backend.models import EmployeeModel
from backend.config import ADMIN_CONFIG
from backend.security import (
    create_admin_token,
    create_employee_token,
    parse_admin_token,
    verify_employee_token,
    verify_pin,
)

router = APIRouter(prefix="/api/auth", tags=["Auth"])


def is_valid_admin_token(token: Optional[str]) -> bool:
    """
    Validate an admin token.

    Tokens are HMAC-signed and time-limited (see backend/security.py). A token is
    only accepted when its signature is intact, it has not expired, and the named
    account still holds administrator rights. There is no master token, no
    forged-hash fallback and no never-expiring credential.
    """
    parsed = parse_admin_token(token)
    if not parsed:
        return False

    username, _issued = parsed
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT is_admin FROM employees
            WHERE LOWER(name) = LOWER(?) OR LOWER(staff_id) = LOWER(?) OR LOWER(email) = LOWER(?)
            """,
            (username, username, username),
        )
        employee = cursor.fetchone()
        return bool(employee and employee["is_admin"] == 1)
    except Exception:
        return False
    finally:
        if conn:
            conn.close()


def is_current_admin(employee_id: int) -> bool:
    """Confirm the account behind an employee session still has admin rights."""
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT is_admin FROM employees WHERE id = ?", (employee_id,))
        row = cursor.fetchone()
        return bool(row and row["is_admin"] == 1)
    except Exception:
        return False
    finally:
        if conn:
            conn.close()


def require_admin(
    x_admin_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """FastAPI dependency protecting admin endpoints. Credentials must travel in a header."""
    token = x_admin_token or authorization
    if not is_valid_admin_token(token):
        raise HTTPException(
            status_code=403,
            detail="Access denied: a valid admin session is required.",
        )
    return True


def require_employee(authorization: Optional[str] = Header(None)):
    """
    FastAPI dependency for employee-scoped endpoints.

    Returns the authenticated employee id. Routes must use this value instead of
    trusting an id supplied by the client, so nobody can act for a colleague.
    """
    employee_id = verify_employee_token(authorization)
    if not employee_id:
        raise HTTPException(
            status_code=401,
            detail="A valid employee session is required. Please sign in again.",
        )
    return employee_id


@router.post("/employee-login")
def employee_login(payload: EmployeeLoginRequest):
    """
    Authenticate an employee by Staff ID, email or name plus PIN.
    Returns a signed, expiring session token used by the attendance endpoints.
    """
    identifier = payload.identifier.strip()
    pin = payload.pin.strip()

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT * FROM employees
        WHERE LOWER(staff_id) = LOWER(?)
           OR LOWER(email) = LOWER(?)
           OR LOWER(name) = LOWER(?)
        """,
        (identifier, identifier, identifier),
    )
    row = cursor.fetchone()
    conn.close()

    if not row:
        raise HTTPException(
            status_code=404,
            detail="Employee profile not found. Please check your Staff ID (e.g. EMP001) or Email.",
        )

    if not verify_pin(pin, row["pin"]):
        raise HTTPException(status_code=401, detail="Invalid security PIN.")

    return {
        "status": "success",
        "message": f"Welcome back, {row['name']}!",
        "token": create_employee_token(row["id"]),
        "employee": EmployeeModel.to_dict(row),
    }


@router.post("/verify-pin")
def verify_pin_endpoint(payload: PinVerification):
    """Verify an employee's PIN without creating a session."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM employees WHERE id = ?", (payload.employee_id,))
    row = cursor.fetchone()
    conn.close()

    if not row or not verify_pin(payload.pin, row["pin"]):
        raise HTTPException(status_code=401, detail="Invalid Employee ID or Security PIN")

    return {
        "status": "success",
        "message": "Authentication successful",
        "employee": EmployeeModel.to_dict(row),
    }


@router.post("/admin-login")
def admin_login(payload: AdminLoginRequest):
    """
    Authenticate an administrator. Requires a correct PIN on an account whose
    ``is_admin`` flag is set; there is no shared master credential.
    """
    username = payload.username.strip()
    pin = payload.pin.strip()

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT * FROM employees
        WHERE LOWER(name) = LOWER(?)
           OR LOWER(staff_id) = LOWER(?)
           OR LOWER(email) = LOWER(?)
        """,
        (username, username, username),
    )
    emp = cursor.fetchone()
    conn.close()

    if not emp or not verify_pin(pin, emp["pin"]):
        raise HTTPException(status_code=401, detail="Invalid administrator credentials.")

    if emp["is_admin"] != 1:
        raise HTTPException(
            status_code=403,
            detail="Access restricted: this account does not have administrator permissions.",
        )

    token = create_admin_token(emp["name"])
    admin_data = {
        "id": emp["id"],
        "name": emp["name"],
        "staff_id": emp["staff_id"],
        "department": emp["department"],
        "is_lead_tech": emp["name"].lower() == ADMIN_CONFIG["lead_tech_name"].lower(),
    }
    return {
        "status": "success",
        "message": f"Welcome back, {emp['name']}!",
        "token": token,
        "user": admin_data,
        "admin": admin_data,
    }


@router.get("/verify-admin")
def verify_admin(
    x_admin_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Check whether the current session token is a valid admin token."""
    token = x_admin_token or authorization
    if not is_valid_admin_token(token):
        raise HTTPException(status_code=403, detail="Invalid or expired admin session.")
    return {"status": "authenticated", "lead_tech": ADMIN_CONFIG["lead_tech_name"]}
