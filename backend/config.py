import os
from pathlib import Path
from datetime import datetime, timezone, timedelta

# Local Workplace Timezone: West Africa Time (WAT / UTC+1)
# Lagos, Nigeria operates on UTC+1 year-round (no DST changes)
WORKPLACE_TIMEZONE = timezone(timedelta(hours=1))

def get_now() -> datetime:
    """Returns current timezone-aware datetime in West Africa Time (UTC+1)"""
    return datetime.now(WORKPLACE_TIMEZONE)

def get_today_str() -> str:
    """Returns today's date formatted as YYYY-MM-DD in WAT"""
    return get_now().strftime("%Y-%m-%d")

def get_current_time_str() -> str:
    """Returns current time formatted as HH:MM:SS in WAT"""
    return get_now().strftime("%H:%M:%S")

def get_timezone_offset() -> str:
    """Returns the workplace timezone offset string, e.g. '+01:00' for WAT (UTC+1)."""
    # WAT is UTC+1, format as +HH:MM
    from datetime import timezone, timedelta
    wat = timezone(timedelta(hours=1))
    utc_now = datetime.now(timezone.utc)
    offset = utc_now.utcoffset(wat)
    total_seconds = int(offset.total_seconds())
    hours = total_seconds // 3600
    minutes = abs(total_seconds % 3600) // 60
    sign = '+' if hours >= 0 else '-'
    return f"{sign}{abs(hours):02d}:{minutes:02d}"

# Base Paths
BASE_DIR = Path(__file__).resolve().parent.parent

# On Vercel / serverless runtimes, root filesystem is read-only except /tmp
if os.environ.get("VERCEL"):
    DB_PATH = "/tmp/clockify.db"
else:
    DB_PATH = os.path.join(BASE_DIR, "clockify.db")

FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

# Default Workplace Geofence (Configured for demo)
DEFAULT_WORKPLACE = {
    "name": "14, Pier Place, Montgomery Road, Yaba",
    "latitude": 6.509309,     # 14 Montgomery Road, Yaba, Lagos, Nigeria
    "longitude": 3.374993,
    "radius_meters": 150.0,   # Allowed perimeter in meters
    "work_start_time": "09:00" # After 09:00 is marked Late
}

# Admin Security & Access Control
# No shared secrets or default credentials live in source: session signing key comes
# from CLOCKIFY_SECRET_KEY (see backend/security.py) and admin PINs are hashed.
ADMIN_CONFIG = {
    "lead_tech_name": "techAlhaji",
    "lead_tech_email": "techalhaji@clockify.dev"
}

# Geolocation Accuracy Threshold: fixes worse than this are rejected.
MAX_ALLOWED_GPS_ACCURACY_METERS = float(os.environ.get("MAX_GPS_ACCURACY_METERS", "80"))
