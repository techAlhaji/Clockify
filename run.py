"""
Clockify — Digital Geofenced Attendance System
Unified Runner Script
"""
import sys
import uvicorn
from backend.database import init_db

def main():
    print("=" * 60)
    print("🚀 Starting Clockify — Geofenced Attendance Server")
    print("=" * 60)
    print("Initializing SQLite Database and default seeds...")
    init_db()
    print("✅ Database ready.")
    print("\nAvailable Services:")
    print("  • Employee Portal:    http://127.0.0.1:8000/")
    print("  • Admin Dashboard:    http://127.0.0.1:8000/admin")
    print("  • Interactive Docs:   http://127.0.0.1:8000/docs")
    print("=" * 60)
    print("Press CTRL+C to stop the server.\n")

    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)

if __name__ == "__main__":
    main()
