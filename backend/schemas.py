from pydantic import BaseModel, Field
from typing import Optional, List

# Geolocation Coordinates Payload
class GeoCoordinates(BaseModel):
    latitude: float = Field(..., ge=-90.0, le=90.0, description="Device GPS latitude")
    longitude: float = Field(..., ge=-180.0, le=180.0, description="Device GPS longitude")
    accuracy: Optional[float] = Field(None, ge=0.0, description="GPS Accuracy in meters")

# Clock-In Request
class ClockInRequest(BaseModel):
    employee_id: int = Field(..., description="Employee primary ID")
    latitude: float = Field(..., ge=-90.0, le=90.0)
    longitude: float = Field(..., ge=-180.0, le=180.0)
    accuracy: Optional[float] = Field(None, description="GPS Accuracy in meters")

# Clock-Out Request
class ClockOutRequest(BaseModel):
    employee_id: int = Field(..., description="Employee primary ID")
    latitude: float = Field(..., ge=-90.0, le=90.0)
    longitude: float = Field(..., ge=-180.0, le=180.0)
    accuracy: Optional[float] = Field(None, description="GPS Accuracy in meters")

# Geofence Update Request
class GeofenceUpdate(BaseModel):
    name: Optional[str] = "Workplace Headquarters"
    latitude: float = Field(..., ge=-90.0, le=90.0)
    longitude: float = Field(..., ge=-180.0, le=180.0)
    radius_meters: float = Field(..., gt=0.0, description="Radius boundary in meters")
    work_start_time: Optional[str] = "09:00"

# Employee Creation
class EmployeeCreate(BaseModel):
    staff_id: str
    name: str
    email: str
    department: str
    pin: Optional[str] = "1234"

# PIN Verification
class PinVerification(BaseModel):
    employee_id: int
    pin: str

# Admin Authentication
class AdminLoginRequest(BaseModel):
    username: str = Field(..., description="Admin username, staff ID or email (e.g. techAlhaji)")
    pin: str = Field(..., description="Security PIN / password (default 1234)")

# Employee Authentication
class EmployeeLoginRequest(BaseModel):
    identifier: str = Field(..., description="Employee Staff ID, email, or full name")
    pin: str = Field(..., description="4-digit security PIN (default 1234)")

# Client Attendance Synchronization
class SyncShiftRequest(BaseModel):
    employee_id: int
    date: str
    clock_in_time: Optional[str] = None
    clock_in_lat: Optional[float] = None
    clock_in_lon: Optional[float] = None
    clock_in_distance: Optional[float] = None
    clock_out_time: Optional[str] = None
    clock_out_lat: Optional[float] = None
    clock_out_lon: Optional[float] = None
    clock_out_distance: Optional[float] = None
    status: str
    is_late: Optional[bool] = False
    notes: Optional[str] = None


