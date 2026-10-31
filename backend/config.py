import os
from pathlib import Path

# Base Paths
BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = os.path.join(BASE_DIR, "clockify.db")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

# Default Workplace Geofence (Can be updated dynamically via Admin API)
DEFAULT_WORKPLACE = {
    "name": "Headquarters - Main Campus",
    "latitude": 6.5244,       # Default sample coordinates (e.g., Lagos, Nigeria)
    "longitude": 3.3792,
    "radius_meters": 150.0,   # Allowed perimeter in meters
    "work_start_time": "09:00" # After 09:00 is marked Late
}

# Geolocation Accuracy Threshold
MAX_ALLOWED_GPS_ACCURACY_METERS = 80.0

# Admin Dashboard Security (override via CLOCKIFY_ADMIN_PIN env var)
ADMIN_PIN = os.getenv("CLOCKIFY_ADMIN_PIN", "1234")
