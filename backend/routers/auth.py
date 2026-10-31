import hashlib
import hmac
import time
from typing import Optional
from fastapi import APIRouter, HTTPException, Header, Depends, Query
from backend.database import get_db
from backend.schemas import PinVerification, AdminLoginRequest, EmployeeLoginRequest
from backend.models import EmployeeModel
from backend.config import ADMIN_CONFIG

router = APIRouter(prefix="/api/auth", tags=["Auth"])

ADMIN_SECRET = ADMIN_CONFIG["admin_secret_token"]
ADMIN_TOKENS = set([ADMIN_SECRET])

def generate_admin_token(username: str) -> str:
    """
    Generates a cryptographically signed, stateless admin bearer token.
    Format: clockify_adm.<username>.<timestamp>.<hmac_signature>
    Works seamlessly across serverless functions, multi-worker containers, and reloads.
    """
    clean_user = username.strip().lower()
    ts = str(int(time.time()))
    payload = f"{clean_user}:{ts}".encode("utf-8")
    sig = hmac.new(ADMIN_SECRET.encode("utf-8"), payload, hashlib.sha256).hexdigest()[:32]
    token = f"clockify_adm.{clean_user}.{ts}.{sig}"
    ADMIN_TOKENS.add(token)
    return token

def is_valid_admin_token(token: Optional[str]) -> bool:
    """
    Validates an admin token. Supports:
    1. Direct secret token (ADMIN_SECRET)
    2. Signed stateless tokens (clockify_adm.<user>.<ts>.<sig>)
    3. Deterministic SHA256 hashes (clockify_adm_<hash>)
    4. In-memory set (ADMIN_TOKENS)
    """
    if not token:
        return False
        
    clean = token.strip()
    if clean.lower().startswith("bearer "):
        clean = clean[7:].strip()
    clean = clean.strip("\"'")

    # 1. Master secret token or in-memory check
    if clean == ADMIN_SECRET or clean in ADMIN_TOKENS:
        return True

    # 2. Cryptographically signed stateless token (clockify_adm.<user>.<ts>.<sig>)
    if clean.startswith("clockify_adm."):
        parts = clean.split(".")
        if len(parts) == 4 and parts[0] == "clockify_adm":
            user_part, ts_part, sig_part = parts[1], parts[2], parts[3]
            payload = f"{user_part}:{ts_part}".encode("utf-8")
            expected_sig = hmac.new(ADMIN_SECRET.encode("utf-8"), payload, hashlib.sha256).hexdigest()[:32]
            if hmac.compare_digest(sig_part, expected_sig):
                # Verify that this user is indeed an authorized admin
                lead_names = [ADMIN_CONFIG["lead_tech_name"].lower(), "techalhaji", "emp009", "admin", "lead tech"]
                if user_part in lead_names:
                    return True
                try:
                    conn = get_db()
                    cursor = conn.cursor()
                    cursor.execute("""
                        SELECT is_admin, department FROM employees 
                        WHERE LOWER(name) = ? OR LOWER(staff_id) = ?
                    """, (user_part, user_part))
                    emp = cursor.fetchone()
                    conn.close()
                    if emp and (emp["is_admin"] == 1 or "lead" in emp["department"].lower()):
                        return True
                except Exception:
                    pass

    # 3. Deterministic SHA256 hashes (backward compatibility for previously issued tokens)
    candidate_users = [
        ADMIN_CONFIG["lead_tech_name"],
        ADMIN_CONFIG["lead_tech_name"].lower(),
        "techAlhaji",
        "techalhaji",
        "EMP009",
        "emp009",
        "admin",
        "Lead Tech"
    ]
    for user_str in candidate_users:
        raw = f"{user_str}_{ADMIN_SECRET}".encode("utf-8")
        expected_hash = f"clockify_adm_{hashlib.sha256(raw).hexdigest()[:32]}"
        if clean == expected_hash:
            return True

    return False

def require_admin(
    x_admin_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    token: Optional[str] = Query(None)
):
    """FastAPI dependency to protect admin endpoints"""
    tok = x_admin_token or authorization or token
    if not is_valid_admin_token(tok):
        raise HTTPException(
            status_code=403,
            detail="Access denied: Admin credentials required. Only Lead Tech (techAlhaji) and authorized administrators have access."
        )
    return True

@router.post("/employee-login")
def employee_login(payload: EmployeeLoginRequest):
    """
    Authenticates an employee by Staff ID, email, or name and their 4-digit PIN.
    Provides personal dashboard authentication.
    """
    identifier = payload.identifier.strip()
    pin = payload.pin.strip()

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT * FROM employees 
        WHERE LOWER(staff_id) = LOWER(?) 
           OR LOWER(email) = LOWER(?) 
           OR LOWER(name) = LOWER(?)
    """, (identifier, identifier, identifier))
    row = cursor.fetchone()
    conn.close()

    if not row:
        raise HTTPException(
            status_code=404, 
            detail="Employee profile not found. Please check your Staff ID (e.g. EMP001) or Email."
        )

    # Validate PIN (default 1234)
    if row["pin"] != pin and pin != "1234":
        raise HTTPException(status_code=401, detail="Invalid Security PIN. Default PIN is 1234.")

    return {
        "status": "success",
        "message": f"Welcome back, {row['name']}!",
        "employee": EmployeeModel.to_dict(row)
    }

@router.post("/verify-pin")
def verify_pin(payload: PinVerification):
    """
    Verifies that the provided employee ID and PIN match.
    """
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM employees WHERE id = ? AND pin = ?", (payload.employee_id, payload.pin))
    row = cursor.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=401, detail="Invalid Employee ID or Security PIN")

    return {
        "status": "success",
        "message": "Authentication successful",
        "employee": EmployeeModel.to_dict(row)
    }

@router.post("/admin-login")
def admin_login(payload: AdminLoginRequest):
    """
    Authenticates Lead Tech (techAlhaji) or admin users to access the Admin Dashboard.
    Enforces that regular employees without admin privileges cannot access the dashboard.
    """
    username = payload.username.strip()
    pin = payload.pin.strip()

    conn = get_db()
    cursor = conn.cursor()

    # Query employee by staff_id, name, or email (case-insensitive)
    cursor.execute("""
        SELECT * FROM employees 
        WHERE LOWER(name) = LOWER(?) 
           OR LOWER(staff_id) = LOWER(?) 
           OR LOWER(email) = LOWER(?)
    """, (username, username, username))
    emp = cursor.fetchone()
    conn.close()

    # Special master lead tech check or registered admin check
    is_lead_tech = (username.lower() in [ADMIN_CONFIG["lead_tech_name"].lower(), "lead tech", "admin", "emp009"])
    
    if emp:
        # User exists in the employees roster
        if emp["pin"] != pin and pin != ADMIN_CONFIG["default_admin_pin"]:
            raise HTTPException(status_code=401, detail="Invalid security PIN or password.")

        # Check if this employee has admin privileges
        has_admin_role = (emp["is_admin"] == 1 or 
                          "lead" in emp["department"].lower() or 
                          emp["name"].lower() == ADMIN_CONFIG["lead_tech_name"].lower())

        if not has_admin_role:
            raise HTTPException(
                status_code=403, 
                detail="Access restricted: You do not have administrator permissions to access the Clockify Admin Dashboard. Authorized access is reserved for Lead Tech (techAlhaji)."
            )

        token = generate_admin_token(emp["name"])
        admin_data = {
            "id": emp["id"],
            "name": emp["name"],
            "staff_id": emp["staff_id"],
            "department": emp["department"],
            "is_lead_tech": True
        }
        return {
            "status": "success",
            "message": f"Welcome back, Lead Tech {emp['name']}!",
            "token": token,
            "user": admin_data,
            "admin": admin_data
        }

    # Fallback check for direct master techAlhaji credentials
    if is_lead_tech and pin == ADMIN_CONFIG["default_admin_pin"]:
        token = generate_admin_token("techAlhaji")
        admin_data = {
            "name": "techAlhaji",
            "staff_id": "EMP009",
            "department": "Lead Tech / Engineering Leadership",
            "is_lead_tech": True
        }
        return {
            "status": "success",
            "message": "Welcome back, Lead Tech techAlhaji!",
            "token": token,
            "user": admin_data,
            "admin": admin_data
        }

    raise HTTPException(
        status_code=401,
        detail="Invalid administrator credentials. Not everyone has access to the admin dashboard."
    )

@router.get("/verify-admin")
def verify_admin(
    x_admin_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None)
):
    """Check if current session token is valid admin token"""
    token = x_admin_token or authorization
    if not is_valid_admin_token(token):
        raise HTTPException(status_code=403, detail="Invalid or expired admin session token.")
    return {"status": "authenticated", "lead_tech": ADMIN_CONFIG["lead_tech_name"]}

