import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from backend.config import FRONTEND_DIR
from backend.database import init_db
from backend.routers import auth, employees, attendance, admin

# Initialize FastAPI App
app = FastAPI(
    title="Clockify API",
    description="Digital Geofenced Attendance System with GPS location verification",
    version="1.0.0"
)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Startup Event: Initialize SQLite Database
@app.on_event("startup")
def on_startup():
    init_db()

# Auto-initialize database on cold module load (essential for serverless runtimes)
try:
    init_db()
except Exception:
    pass

# Mount API Routers
app.include_router(auth.router)
app.include_router(employees.router)
app.include_router(attendance.router)
app.include_router(admin.router)

# Serve Frontend Static Assets
if os.path.exists(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/")
    def serve_employee_portal():
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

    @app.get("/admin")
    def serve_admin_portal():
        return FileResponse(os.path.join(FRONTEND_DIR, "admin.html"))

    @app.get("/manifest.webmanifest")
    def serve_manifest():
        return FileResponse(
            os.path.join(FRONTEND_DIR, "manifest.webmanifest"),
            media_type="application/manifest+json",
        )

    # The service worker must be served from the root so its default scope
    # covers the whole app shell (/*), not just /static/*.
    @app.get("/service-worker.js")
    def serve_service_worker():
        return FileResponse(
            os.path.join(FRONTEND_DIR, "service-worker.js"),
            media_type="application/javascript",
            headers={
                "Service-Worker-Allowed": "/",
                "Cache-Control": "no-cache, no-store, must-revalidate",
            },
        )

    @app.get("/offline")
    def serve_offline_screen():
        return FileResponse(os.path.join(FRONTEND_DIR, "offline.html"))
