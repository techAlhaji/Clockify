"""
Schedule, shift assignment, holiday calendar and workforce duration service.

Handles:
- Per-employee schedule lookup by date (historical, non-destructive)
- Calendar & holiday evaluation (company and site scope, working day overrides)
- Seconds-precision punctuality evaluation with grace periods and overnight shifts
- Server-side duration, break deductions, and overtime calculations
- Pay period locking verification
"""
from datetime import datetime, date, timedelta, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

from backend.config import WORKPLACE_TIMEZONE, get_now


WEEKDAY_MAP = {
    "mon": 1, "monday": 1, "1": 1, 1: 1,
    "tue": 2, "tuesday": 2, "2": 2, 2: 2,
    "wed": 3, "wednesday": 3, "3": 3, 3: 3,
    "thu": 4, "thursday": 4, "4": 4, 4: 4,
    "fri": 5, "friday": 5, "5": 5, 5: 5,
    "sat": 6, "saturday": 6, "6": 6, 6: 6,
    "sun": 7, "sunday": 7, "7": 7, 7: 7,
}


def parse_days_of_week(val: Any) -> Set[int]:
    """
    Parse a days_of_week value (e.g. "1,2,3,4,5", "[1, 2, 3, 4, 5]", or "MON,TUE,WED,THU,FRI")
    into a set of ISO integers where 1=Monday .. 7=Sunday.
    """
    if not val:
        return {1, 2, 3, 4, 5}
    if isinstance(val, (list, tuple, set)):
        result = set()
        for item in val:
            k = str(item).strip().lower()
            if k in WEEKDAY_MAP:
                result.add(WEEKDAY_MAP[k])
        return result or {1, 2, 3, 4, 5}

    cleaned = str(val).replace("[", "").replace("]", "").replace('"', "").replace("'", "")
    parts = [p.strip().lower() for p in cleaned.split(",") if p.strip()]
    result = set()
    for p in parts:
        if p in WEEKDAY_MAP:
            result.add(WEEKDAY_MAP[p])
    return result or {1, 2, 3, 4, 5}


def format_minutes_to_hours_mins(minutes: int) -> str:
    """Format integer minutes as 'X h Y m'."""
    mins = max(0, int(minutes or 0))
    hours = mins // 60
    rem = mins % 60
    return f"{hours} h {rem} m"


def get_default_schedule_dict() -> Dict[str, Any]:
    """Standard company fallback schedule (09:00-17:00, 5 min grace, 60 min break)."""
    return {
        "id": 1,
        "name": "Standard Day Shift",
        "start_time": "09:00",
        "end_time": "17:00",
        "days_of_week": "1,2,3,4,5",
        "grace_minutes": 5,
        "break_minutes": 60,
        "break_is_paid": 0,
        "required_minutes": 420,
        "is_overnight": 0,
        "overtime_threshold_daily_minutes": 480,
    }


def get_employee_schedule_for_date(cursor, employee_id: int, date_str: str) -> Dict[str, Any]:
    """
    Find the active shift assignment for an employee on a given date.
    Changes to assignments are effective-dated and historical, never destructive.
    Falls back to the company default schedule if none assigned.
    """
    clean_date = str(date_str).strip()
    cursor.execute("""
        SELECT s.*, sa.id AS assignment_id, sa.site_id, sa.effective_from, sa.effective_to
        FROM shift_assignments sa
        JOIN schedules s ON sa.schedule_id = s.id
        WHERE sa.employee_id = ?
          AND sa.effective_from <= ?
          AND (sa.effective_to IS NULL OR sa.effective_to = '' OR sa.effective_to >= ?)
        ORDER BY sa.effective_from DESC, sa.id DESC
        LIMIT 1
    """, (employee_id, clean_date, clean_date))
    row = cursor.fetchone()
    if row:
        return dict(row)

    # Fallback: check first schedule in database
    cursor.execute("SELECT * FROM schedules ORDER BY id ASC LIMIT 1")
    first_sched = cursor.fetchone()
    if first_sched:
        return dict(first_sched)

    return get_default_schedule_dict()


def is_working_day(
    cursor,
    employee_id: int,
    date_str: str,
    site_id: Optional[int] = None
) -> Tuple[bool, str]:
    """
    Determine if a date is a working day for the given employee.
    Considers:
    1. Calendar holidays (company or site scope) with is_working_day overrides.
    2. Employee schedule days_of_week.
    Returns (is_working, reason).
    """
    clean_date = str(date_str).strip()

    # 1. Check holiday calendar
    if site_id:
        cursor.execute("""
            SELECT name, is_working_day FROM holidays
            WHERE date = ? AND (scope = 'company' OR (scope = 'site' AND site_id = ?))
            ORDER BY is_working_day DESC LIMIT 1
        """, (clean_date, site_id))
    else:
        cursor.execute("""
            SELECT name, is_working_day FROM holidays
            WHERE date = ? AND scope = 'company'
            ORDER BY is_working_day DESC LIMIT 1
        """, (clean_date,))
    holiday = cursor.fetchone()

    if holiday:
        is_override = bool(holiday["is_working_day"])
        name = holiday["name"]
        if is_override:
            return True, f"Working Day Override ({name})"
        return False, f"Holiday: {name}"

    # 2. Check scheduled working days
    try:
        dt = datetime.strptime(clean_date, "%Y-%m-%d")
        iso_day = dt.isoweekday()  # 1=Mon .. 7=Sun
    except ValueError:
        return True, "Default Working Day"

    sched = get_employee_schedule_for_date(cursor, employee_id, clean_date)
    working_days = parse_days_of_week(sched.get("days_of_week", "1,2,3,4,5"))

    if iso_day in working_days:
        return True, "Scheduled Working Day"
    return False, "Weekend / Scheduled Rest Day"


def _time_str_to_seconds(time_val: Any) -> int:
    """Parse 'HH:MM' or 'HH:MM:SS' or datetime into total seconds from midnight."""
    if isinstance(time_val, datetime):
        return time_val.hour * 3600 + time_val.minute * 60 + time_val.second
    s = str(time_val).strip()
    # Check if ISO string
    if "T" in s:
        dt = datetime.fromisoformat(s)
        return dt.hour * 3600 + dt.minute * 60 + dt.second
    parts = s.split(":")
    hours = int(parts[0])
    mins = int(parts[1]) if len(parts) > 1 else 0
    secs = int(float(parts[2])) if len(parts) > 2 else 0
    return hours * 3600 + mins * 60 + secs


def calculate_punctuality(
    schedule: Dict[str, Any],
    arrival_val: Any,
    shift_date: str = ""
) -> Tuple[int, int, str]:
    """
    Evaluates arrival against schedule start time with seconds precision and grace period.
    Returns (is_late: int (0 or 1), late_minutes: int, note: str).

    Acceptance criteria:
    - 14:00-22:00 employee arriving at 14:02 is On-time.
    - 09:00:30 arrival with 5-minute grace is On-time (cutoff 09:05:00).
    - 09:06:00 arrival is Late.
    """
    start_str = schedule.get("start_time") or "09:00"
    start_seconds = _time_str_to_seconds(start_str)
    grace_minutes = int(schedule.get("grace_minutes", 0) or 0)
    cutoff_seconds = start_seconds + (grace_minutes * 60)

    arrival_seconds = _time_str_to_seconds(arrival_val)
    is_overnight = bool(schedule.get("is_overnight"))

    # Overnight shift handling: if arrival is after midnight (e.g. 00:05), adjust
    if is_overnight and arrival_seconds < 43200 and start_seconds >= 43200:
        arrival_seconds += 86400

    if arrival_seconds <= cutoff_seconds:
        return 0, 0, f"On-time arrival ({schedule.get('name', 'Shift')})"

    diff_seconds = arrival_seconds - start_seconds
    late_minutes = max(1, int((diff_seconds + 59) // 60))
    return 1, late_minutes, f"Late arrival ({late_minutes}m late against {start_str})"


def parse_datetime(val: Any) -> datetime:
    """Parse an ISO timestamp, datetime object, or date+time string into aware datetime."""
    if isinstance(val, datetime):
        if val.tzinfo is None:
            return val.replace(tzinfo=WORKPLACE_TIMEZONE)
        return val
    s = str(val).strip()
    if "T" in s:
        try:
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=WORKPLACE_TIMEZONE)
            return dt
        except Exception:
            pass
    # Try date + time formats
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%H:%M:%S", "%H:%M"):
        try:
            parsed = datetime.strptime(s, fmt)
            return parsed.replace(tzinfo=WORKPLACE_TIMEZONE)
        except ValueError:
            continue
    return get_now()


def calculate_shift_duration(
    started_at: Any,
    ended_at: Any,
    schedule: Dict[str, Any],
    explicit_break_minutes: int = 0
) -> Dict[str, Any]:
    """
    Server-computed duration, break deduction, and overtime calculation.
    Timezone-safe and supports overnight shifts.
    """
    dt_start = parse_datetime(started_at)
    dt_end = parse_datetime(ended_at)

    if dt_end < dt_start:
        # Midnight crossing
        dt_end = dt_end + timedelta(days=1)

    elapsed_seconds = (dt_end - dt_start).total_seconds()
    elapsed_minutes = max(0, int(round(elapsed_seconds / 60)))

    # Break calculation
    sched_break = int(schedule.get("break_minutes", 0) or 0)
    is_paid_break = bool(schedule.get("break_is_paid", 0))

    if explicit_break_minutes > 0:
        unpaid_break = 0 if is_paid_break else explicit_break_minutes
        total_break = explicit_break_minutes
    elif sched_break > 0 and not is_paid_break:
        # Configurable auto-deduction: deducted if worked at least 4 hours (240 min)
        if elapsed_minutes >= 240:
            unpaid_break = sched_break
        else:
            unpaid_break = 0
        total_break = unpaid_break
    else:
        unpaid_break = 0
        total_break = 0

    worked_minutes = max(0, elapsed_minutes - unpaid_break)

    # Overtime calculation
    daily_threshold = int(
        schedule.get("overtime_threshold_daily_minutes")
        or schedule.get("required_minutes")
        or 480
    )
    overtime_minutes = max(0, worked_minutes - daily_threshold)

    return {
        "elapsed_minutes": elapsed_minutes,
        "break_minutes": total_break,
        "worked_minutes": worked_minutes,
        "overtime_minutes": overtime_minutes,
        "worked_hours": round(worked_minutes / 60.0, 2),
        "worked_display": format_minutes_to_hours_mins(worked_minutes),
    }


def is_period_locked(cursor, target_date: str) -> Tuple[bool, Optional[Dict[str, Any]]]:
    """
    Check if a target date belongs to an approved & locked payroll period.
    Locked periods reject any further edits to prevent altering paid figures.
    """
    clean_date = str(target_date).strip()
    cursor.execute("""
        SELECT * FROM payroll_periods
        WHERE status = 'LOCKED'
          AND start_date <= ?
          AND end_date >= ?
        ORDER BY id DESC
        LIMIT 1
    """, (clean_date, clean_date))
    row = cursor.fetchone()
    if row:
        return True, dict(row)
    return False, None
