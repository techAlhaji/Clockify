from pydantic import BaseModel, Field
from typing import Optional, List

# Geolocation Coordinates Payload
class GeoCoordinates(BaseModel):
    latitude: float = Field(..., ge=-90.0, le=90.0, description="Device GPS latitude")
    longitude: float = Field(..., ge=-180.0, le=180.0, description="Device GPS longitude")
    accuracy: Optional[float] = Field(None, ge=0.0, description="GPS Accuracy in meters")

# Clock-In Request
# The employee is identified by the session token, never by the request body.
class ClockInRequest(BaseModel):
    latitude: float = Field(..., ge=-90.0, le=90.0)
    longitude: float = Field(..., ge=-180.0, le=180.0)
    accuracy: Optional[float] = Field(None, ge=0.0, description="GPS Accuracy in meters")

# Clock-Out Request
class ClockOutRequest(BaseModel):
    latitude: float = Field(..., ge=-90.0, le=90.0)
    longitude: float = Field(..., ge=-180.0, le=180.0)
    accuracy: Optional[float] = Field(None, ge=0.0, description="GPS Accuracy in meters")

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
    pin: str = Field(..., min_length=4, max_length=8, description="4-8 digit PIN; stored hashed")

# PIN Verification
class PinVerification(BaseModel):
    employee_id: int
    pin: str

# Admin Authentication
class AdminLoginRequest(BaseModel):
    username: str = Field(..., description="Admin username, staff ID or email (e.g. techAlhaji)")
    pin: str = Field(..., description="Security PIN for an administrator account")

# Employee Authentication
class EmployeeLoginRequest(BaseModel):
    identifier: str = Field(..., description="Employee Staff ID, email, or full name")
    pin: str = Field(..., description="Employee security PIN")


