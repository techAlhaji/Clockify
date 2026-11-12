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

# Schedule & Shift Schemas
class ScheduleCreate(BaseModel):
    name: str = Field(..., min_length=1, description="Schedule name (e.g. Standard Day Shift)")
    start_time: Optional[str] = Field(None, description="Start time HH:MM (e.g. 09:00)")
    start: Optional[str] = Field(None, description="Alias for start_time")
    end_time: Optional[str] = Field(None, description="End time HH:MM (e.g. 17:00)")
    end: Optional[str] = Field(None, description="Alias for end_time")
    days_of_week: Optional[str] = Field("1,2,3,4,5", description="Working days 1=Mon..7=Sun, or comma-separated")
    grace_minutes: Optional[int] = Field(5, ge=0, description="Grace period before marked late")
    break_minutes: Optional[int] = Field(60, ge=0, description="Break duration in minutes")
    break_is_paid: Optional[int] = Field(0, description="0 for unpaid break, 1 for paid")
    required_minutes: Optional[int] = Field(480, ge=0, description="Required working minutes per day")
    is_overnight: Optional[int] = Field(0, description="1 if shift crosses midnight")
    overtime_threshold_daily_minutes: Optional[int] = Field(480, ge=0, description="Daily overtime threshold")

class ScheduleUpdate(BaseModel):
    name: Optional[str] = None
    start_time: Optional[str] = None
    start: Optional[str] = None
    end_time: Optional[str] = None
    end: Optional[str] = None
    days_of_week: Optional[str] = None
    grace_minutes: Optional[int] = None
    break_minutes: Optional[int] = None
    break_is_paid: Optional[int] = None
    required_minutes: Optional[int] = None
    is_overnight: Optional[int] = None
    overtime_threshold_daily_minutes: Optional[int] = None

class ShiftAssignmentCreate(BaseModel):
    employee_id: int = Field(..., description="Employee ID")
    schedule_id: int = Field(..., description="Schedule ID")
    site_id: Optional[int] = Field(None, description="Optional geofence site ID")
    effective_from: str = Field(..., description="Start date YYYY-MM-DD")
    effective_to: Optional[str] = Field(None, description="End date YYYY-MM-DD (or NULL)")

class ShiftAssignmentUpdate(BaseModel):
    schedule_id: Optional[int] = None
    site_id: Optional[int] = None
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None

class HolidayCreate(BaseModel):
    date: str = Field(..., description="Date YYYY-MM-DD")
    name: str = Field(..., min_length=1, description="Holiday name")
    scope: Optional[str] = Field("company", description="'company' or 'site'")
    site_id: Optional[int] = Field(None, description="Site ID if site scope")
    is_working_day: Optional[int] = Field(0, description="0=holiday/off-day, 1=working day override")

class PayrollPeriodCreate(BaseModel):
    name: str = Field(..., min_length=1, description="Period name (e.g. November 2026)")
    start_date: str = Field(..., description="Start date YYYY-MM-DD")
    end_date: str = Field(..., description="End date YYYY-MM-DD")
    notes: Optional[str] = None

class BreakCreate(BaseModel):
    break_minutes: int = Field(..., ge=1, description="Explicit break duration in minutes")
    is_paid: Optional[int] = Field(0, description="0 for unpaid break, 1 for paid")


