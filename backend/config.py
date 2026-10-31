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
ADMIN_CONFIG = {
    "lead_tech_name": "techAlhaji",
    "lead_tech_email": "techalhaji@clockify.dev",
    "default_admin_pin": "1234",
    "admin_secret_token": "clockify_admin_secure_techAlhaji_token_2026"
}

# Geolocation Accuracy Threshold
MAX_ALLOWED_GPS_ACCURACY_METERS = 80.0
