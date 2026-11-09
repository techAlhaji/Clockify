import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.config import (
    CLOCK_INTENT_TTL_SECONDS,
    MAX_CLOCK_SKEW_SECONDS,
    MAX_INTENT_AGE_SECONDS,
    get_now,
    get_today_str,
)
from backend.database import get_db
from backend.models import AttendanceModel
from backend.routers.auth import require_employee
from backend.schemas import ClockInRequest, ClockIntentRequest, ClockOutRequest
from backend.services.geofence import verify_geofence

router = APIRouter(prefix="/api/attendance", tags=["Attendance"])

ACCURACY_MESSAGES = {
    "ACCURACY_MISSING": "Your device did not report a GPS accuracy value, so your location cannot be verified. Enable precise location and try again.",
    "ACCURACY_TOO_LOW": "Your GPS signal is too imprecise to verify your location. Step outside or near a window and try again.",
}

# Server-issued intents are 32 hex chars; client offline intents are RFC 4122 UUIDs.
INTENT_ID_PATTERN = re.compile(
    r"^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})$"
)

RECORD_SELECT = """
    SELECT a.*, e.name, e.department, e.staff_id
    FROM attendance_records a
    JOIN employees e ON a.employee_id = e.id
"""


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def _parse_timestamp(value) -> Optional[datetime]:
    if value is None or isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def _as_aware(value: Optional[datetime]) -> Optional[datetime]:
    """Naive client timestamps are treated as UTC (the browser sends toISOString)."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _error(status_code: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"error": code, "message": message, **extra},
    )


def _fetch_record(cursor, record_id: Optional[int]):
    if not record_id:
        return None
    cursor.execute(f"{RECORD_SELECT} WHERE a.id = ?", (record_id,))
    return cursor.fetchone()


def _fetch_today_record(cursor, employee_id: int, today_str: str):
    cursor.execute(
        f"{RECORD_SELECT} WHERE a.employee_id = ? AND a.date = ? ORDER BY a.id DESC LIMIT 1",
        (employee_id, today_str),
    )
    return cursor.fetchone()


def _mark_intent(cursor, intent_id: Optional[str], intent_status: str,
                 record_id: Optional[int] = None, message: Optional[str] = None):
    if not intent_id:
        return
    cursor.execute(
        """
        UPDATE clock_intents
        SET status = ?, record_id = COALESCE(?, record_id), message = ?
        WHERE intent_id = ?
        """,
        (intent_status, record_id, message, intent_id),
    )


def _reject_intent(cursor, intent_id: Optional[str], status_code: int,
                   code: str, message: str, **extra) -> HTTPException:
    """Persist a terminal rejection on the intent, then return the HTTP error."""
    _mark_intent(cursor, intent_id, "REJECTED", message=message)
    return _error(status_code, code, message, **extra)


def _duplicate_response(record, message: str) -> dict:
    return {
        "status": "success",
        "confirmed": True,
        "duplicate": True,
        "message": message,
        "record": AttendanceModel.to_dict(record),
        "geofence": None,
    }


def _reject_location(cursor, intent_id, geo_check):
    """Reject a failed geofence/accuracy check with the same shape as other routes."""
    reason = geo_check.get("reason") or "OUTSIDE_GEOFENCE"
    if reason in ACCURACY_MESSAGES:
        raise _reject_intent(
            cursor,
            intent_id,
            403,
            reason,
            ACCURACY_MESSAGES[reason],
            gps_accuracy_meters=geo_check.get("gps_accuracy_meters"),
            max_allowed_accuracy_meters=geo_check.get("max_allowed_accuracy_meters"),
        )
    raise _reject_intent(
        cursor,
        intent_id,
        403,
        "OUTSIDE_GEOFENCE",
        f"You are outside the workplace perimeter. You are {geo_check['distance_meters']}m away "
        f"(Allowed radius: {geo_check['allowed_radius_meters']}m).",
        distance_meters=geo_check["distance_meters"],
        allowed_radius_meters=geo_check["allowed_radius_meters"],
        gps_accuracy_meters=geo_check.get("gps_accuracy_meters"),
    )


def _resolve_intent(cursor, payload, action: str, employee_id: int,
                    now: datetime) -> Tuple[Optional[str], Optional[dict], Optional[datetime]]:
    """
    Validate and claim the idempotency key for an incoming clock event.

    Returns ``(intent_id, duplicate_response, client_captured_at)``. A set
    ``duplicate_response`` means the event was already applied and must be
    returned instead of creating a second record.
    """
    raw_id = getattr(payload, "client_intent_id", None)
    intent_id = raw_id.strip() if isinstance(raw_id, str) and raw_id.strip() else None

    if intent_id and not INTENT_ID_PATTERN.match(intent_id):
        raise _error(
            422,
            "INVALID_INTENT_ID",
            "Clock intent id must be a UUID or a server-issued intent id.",
        )

    intent = None
    if intent_id:
        cursor.execute("SELECT * FROM clock_intents WHERE intent_id = ?", (intent_id,))
        intent = cursor.fetchone()

    if intent and (intent["employee_id"] != employee_id or intent["action"] != action):
        raise _error(
            409,
            "INTENT_MISMATCH",
            "This clock intent belongs to a different employee or clock action.",
        )

    if intent and intent["status"] in ("CONFIRMED", "DUPLICATE"):
        existing = _fetch_record(cursor, intent["record_id"])
        if existing:
            message = (
                "This clock event was already recorded; the existing record was returned."
                if intent["status"] == "CONFIRMED"
                else "A record for this shift already exists; the existing record was returned."
            )
            return intent_id, _duplicate_response(existing, message), None
        raise _error(
            409,
            "INTENT_STATE_CONFLICT",
            "Clock intent is marked complete but its attendance record is missing.",
        )

    if intent and intent["status"] == "REJECTED":
        raise _error(
            422,
            "INTENT_REJECTED",
            intent["message"] or "This clock intent was already rejected by the server.",
        )

    if intent and intent["status"] == "PROCESSING":
        # A concurrent duplicate tap is still in flight. Let the client retry
        # shortly; a crashed/stale claim (older than 60s) is reclaimed below.
        received_at = _as_aware(_parse_timestamp(intent["received_at"]))
        if received_at and (now - received_at).total_seconds() < 60:
            raise _error(
                409,
                "INTENT_IN_PROGRESS",
                "This clock event is already being processed. Retrying shortly.",
            )

    client_captured = _parse_timestamp(payload.client_captured_at)
    if payload.client_captured_at is not None and client_captured is None:
        raise _error(422, "INVALID_CAPTURE_TIME", "client_captured_at must be an ISO-8601 timestamp.")

    if intent_id and intent is None:
        # A UUID captured while offline: register it so a retry of the same
        # event can never be applied twice.
        cursor.execute(
            """
            INSERT INTO clock_intents
                (intent_id, employee_id, action, client_captured_at, issued_at, received_at, status)
            VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING')
            """,
            (intent_id, employee_id, action, _iso(client_captured), _iso(now), _iso(now)),
        )
    elif intent is not None:
        cursor.execute(
            """
            UPDATE clock_intents
            SET status = 'PROCESSING',
                received_at = ?,
                client_captured_at = COALESCE(client_captured_at, ?)
            WHERE intent_id = ?
            """,
            (_iso(now), _iso(client_captured), intent_id),
        )
        if client_captured is None and intent["client_captured_at"]:
            client_captured = _parse_timestamp(intent["client_captured_at"])

    # A server-issued intent must be used inside its short lifetime.
    if intent is not None and intent["issued_at"]:
        issued_at = _as_aware(_parse_timestamp(intent["issued_at"]))
        if issued_at and (now - issued_at).total_seconds() > CLOCK_INTENT_TTL_SECONDS:
            raise _reject_intent(
                cursor,
                intent_id,
                422,
                "INTENT_EXPIRED",
                f"This clock intent expired (limit {CLOCK_INTENT_TTL_SECONDS // 60} minutes). "
                "Nothing was recorded — please capture the event again.",
            )

    # The client may only replay an intent: the server rejects events captured
    # outside the allowed offline window instead of trusting device time.
    captured_aware = _as_aware(client_captured)
    if captured_aware:
        age_seconds = (now - captured_aware).total_seconds()
        if age_seconds > MAX_INTENT_AGE_SECONDS:
            minutes = MAX_INTENT_AGE_SECONDS // 60
            raise _reject_intent(
                cursor,
                intent_id,
                422,
                "INTENT_EXPIRED",
                f"Your clock event was captured {int(age_seconds // 60)} minutes ago, which is outside "
                f"the {minutes}-minute offline window. Nothing was recorded — please capture the event again.",
                max_intent_age_seconds=MAX_INTENT_AGE_SECONDS,
            )
        if age_seconds < -MAX_CLOCK_SKEW_SECONDS:
            raise _reject_intent(
                cursor,
                intent_id,
                422,
                "INVALID_CAPTURE_TIME",
                "The clock event timestamp is in the future. Check your device clock and try again.",
            )

    return intent_id, None, client_captured


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/intent")
def issue_clock_intent(payload: ClockIntentRequest, employee_id: int = Depends(require_employee)):
    """
    Issue a short-lived, single-use clock_intent_id for the authenticated employee.

    Online taps use this token; offline taps fall back to a client-generated
    UUID, which the server also stores and deduplicates.
    """
    now = get_now()
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT id FROM employees WHERE id = ?", (employee_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="Employee not found")

        # Opportunistic cleanup of never-used tokens.
        cursor.execute(
            "DELETE FROM clock_intents WHERE status = 'ISSUED' AND issued_at < ?",
            (_iso(now - timedelta(days=1)),),
        )

        token = uuid.uuid4().hex
        cursor.execute(
            """
            INSERT INTO clock_intents
                (intent_id, employee_id, action, issued_at, status)
            VALUES (?, ?, ?, ?, 'ISSUED')
            """,
            (token, employee_id, payload.action, _iso(now)),
        )
        conn.commit()

        return {
            "intent_id": token,
            "employee_id": employee_id,
            "action": payload.action,
            "issued_at": _iso(now),
            "expires_at": _iso(now + timedelta(seconds=CLOCK_INTENT_TTL_SECONDS)),
            "expires_in_seconds": CLOCK_INTENT_TTL_SECONDS,
            "max_intent_age_seconds": MAX_INTENT_AGE_SECONDS,
        }
    finally:
        conn.close()


@router.post("/clock-in")
def clock_in(payload: ClockInRequest, employee_id: int = Depends(require_employee)):
    """
    Validate GPS location against the active geofence and record clock-in for
    the authenticated employee.

    The server owns the authoritative timestamp (receipt time); the device
    capture time is stored alongside it. A repeated intent or an existing shift
    returns the existing record instead of creating a duplicate.
    """
    now = get_now()
    today_str = get_today_str()
    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute("SELECT * FROM employees WHERE id = ?", (employee_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="Employee not found")

        intent_id, duplicate, client_captured = _resolve_intent(
            cursor, payload, "IN", employee_id, now
        )
        if duplicate:
            conn.commit()
            return duplicate

        # Conflict handling: one record per employee per shift. A queued replay
        # that races an already-recorded shift resolves to that record.
        existing = _fetch_today_record(cursor, employee_id, today_str)
        if existing and existing["clock_in_time"]:
            _mark_intent(cursor, intent_id, "DUPLICATE", existing["id"])
            conn.commit()
            return _duplicate_response(
                existing,
                "A clock-in is already recorded for today. The existing record was returned.",
            )

        cursor.execute("SELECT * FROM geofence_settings ORDER BY id DESC LIMIT 1")
        geofence = cursor.fetchone()
        if not geofence:
            raise HTTPException(status_code=500, detail="Workplace geofence settings not configured")

        geo_check = verify_geofence(
            user_lat=payload.latitude,
            user_lon=payload.longitude,
            office_lat=geofence["latitude"],
            office_lon=geofence["longitude"],
            allowed_radius=geofence["radius_meters"],
            gps_accuracy=payload.accuracy,
        )

        if not geo_check["is_inside"]:
            _reject_location(cursor, intent_id, geo_check)

        start_time_str = geofence["work_start_time"] or "09:00"
        try:
            start_hour, start_minute = map(int, start_time_str.split(":")[:2])
        except Exception:
            start_hour, start_minute = (9, 0)
        is_late = 1 if (now.hour, now.minute) > (start_hour, start_minute) else 0

        # clock_in_time is the server receipt time, never the device timestamp.
        cursor.execute(
            """
            INSERT INTO attendance_records (
                employee_id, date, clock_in_time, clock_in_lat, clock_in_lon,
                clock_in_distance, status, is_late, notes,
                clock_in_client_captured_at, clock_in_received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                employee_id,
                today_str,
                now.strftime("%H:%M:%S"),
                payload.latitude,
                payload.longitude,
                geo_check["distance_meters"],
                "CLOCKED_IN",
                is_late,
                "Arrived within geofence perimeter",
                _iso(client_captured),
                _iso(now),
            ),
        )
        new_record_id = cursor.lastrowid
        _mark_intent(cursor, intent_id, "CONFIRMED", new_record_id)
        conn.commit()

        created_record = _fetch_record(cursor, new_record_id)
        return {
            "status": "success",
            "confirmed": True,
            "duplicate": False,
            "message": "Successfully clocked in! Arrival recorded.",
            "record": AttendanceModel.to_dict(created_record),
            "geofence": geo_check,
        }
    except HTTPException:
        # Persist intent rejection/duplicate state created while handling the error.
        conn.commit()
        raise
    finally:
        conn.close()


@router.post("/clock-out")
def clock_out(payload: ClockOutRequest, employee_id: int = Depends(require_employee)):
    """
    Record departure for the authenticated employee. The server receipt time is
    authoritative; a repeated intent resolves to the existing record.
    """
    now = get_now()
    today_str = get_today_str()
    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute("SELECT id FROM employees WHERE id = ?", (employee_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="Employee not found")

        intent_id, duplicate, client_captured = _resolve_intent(
            cursor, payload, "OUT", employee_id, now
        )
        if duplicate:
            conn.commit()
            return duplicate

        record = _fetch_today_record(cursor, employee_id, today_str)
        if not record:
            raise _reject_intent(
                cursor,
                intent_id,
                400,
                "NO_OPEN_SHIFT",
                "No clock-in record found for today. Please clock in first.",
            )

        if record["status"] == "CLOCKED_OUT":
            _mark_intent(cursor, intent_id, "DUPLICATE", record["id"])
            conn.commit()
            return _duplicate_response(
                record,
                "A clock-out is already recorded for today. The existing record was returned.",
            )

        cursor.execute("SELECT * FROM geofence_settings ORDER BY id DESC LIMIT 1")
        geofence = cursor.fetchone()
        if not geofence:
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
            _reject_location(cursor, intent_id, geo_check)

        cursor.execute(
            """
            UPDATE attendance_records
            SET clock_out_time = ?,
                clock_out_lat = ?,
                clock_out_lon = ?,
                clock_out_distance = ?,
                clock_out_client_captured_at = ?,
                clock_out_received_at = ?,
                status = 'CLOCKED_OUT'
            WHERE id = ?
            """,
            (
                now.strftime("%H:%M:%S"),
                payload.latitude,
                payload.longitude,
                geo_check["distance_meters"],
                _iso(client_captured),
                _iso(now),
                record["id"],
            ),
        )
        _mark_intent(cursor, intent_id, "CONFIRMED", record["id"])
        conn.commit()

        updated_record = _fetch_record(cursor, record["id"])
        return {
            "status": "success",
            "confirmed": True,
            "duplicate": False,
            "message": "Successfully clocked out! Departure recorded.",
            "record": AttendanceModel.to_dict(updated_record),
            "geofence": geo_check,
        }
    except HTTPException:
        conn.commit()
        raise
    finally:
        conn.close()


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
        f"""
        {RECORD_SELECT}
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
    limit: int = 10,
    authenticated_employee_id: int = Depends(require_employee),
):
    """Retrieve recent attendance history for the authenticated employee only."""
    if employee_id != authenticated_employee_id:
        raise HTTPException(status_code=403, detail="You may only view your own attendance history.")

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        f"""
        {RECORD_SELECT}
        WHERE a.employee_id = ?
        ORDER BY a.date DESC, a.id DESC
        LIMIT ?
        """,
        (employee_id, limit),
    )
    rows = cursor.fetchall()
    conn.close()

    return [AttendanceModel.to_dict(row) for row in rows]
