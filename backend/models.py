from typing import Optional, Dict, Any

class EmployeeModel:
    @staticmethod
    def to_dict(row) -> Dict[str, Any]:
        if not row:
            return {}
        return {
            "id": row["id"],
            "staff_id": row["staff_id"],
            "name": row["name"],
            "email": row["email"],
            "department": row["department"],
            "is_admin": bool(row["is_admin"]) if "is_admin" in row.keys() else False,
            "created_at": row["created_at"]
        }

class AttendanceModel:
    @staticmethod
    def to_dict(row) -> Dict[str, Any]:
        if not row:
            return {}
        keys = row.keys() if hasattr(row, "keys") else []
        emp_name = row["name"] if "name" in keys else (row["employee_name"] if "employee_name" in keys else None)
        staff_id = row["staff_id"] if "staff_id" in keys else None
        dept = row["department"] if "department" in keys else None
        
        worked_mins = row["worked_minutes"] if "worked_minutes" in keys and row["worked_minutes"] is not None else 0
        hours = worked_mins // 60
        mins = worked_mins % 60
        worked_display = f"{hours} h {mins} m"

        return {
            "id": row["id"] if "id" in keys else None,
            "employee_id": row["employee_id"] if "employee_id" in keys else None,
            "name": emp_name,
            "employee_name": emp_name,
            "staff_id": staff_id,
            "department": dept,
            "date": row["date"] if "date" in keys else None,
            "clock_in_time": row["clock_in_time"] if "clock_in_time" in keys else None,
            "clock_in_lat": row["clock_in_lat"] if "clock_in_lat" in keys else None,
            "clock_in_lon": row["clock_in_lon"] if "clock_in_lon" in keys else None,
            "clock_in_distance": row["clock_in_distance"] if "clock_in_distance" in keys else None,
            "clock_out_time": row["clock_out_time"] if "clock_out_time" in keys else None,
            "clock_out_lat": row["clock_out_lat"] if "clock_out_lat" in keys else None,
            "clock_out_lon": row["clock_out_lon"] if "clock_out_lon" in keys else None,
            "clock_out_distance": row["clock_out_distance"] if "clock_out_distance" in keys else None,
            "status": row["status"] if "status" in keys else None,
            "is_late": bool(row["is_late"]) if "is_late" in keys and row["is_late"] is not None else False,
            "notes": row["notes"] if "notes" in keys else None,
            "started_at": row["started_at"] if "started_at" in keys else None,
            "ended_at": row["ended_at"] if "ended_at" in keys else None,
            "worked_minutes": worked_mins,
            "worked_time_display": worked_display,
            "break_minutes": row["break_minutes"] if "break_minutes" in keys and row["break_minutes"] is not None else 0,
            "overtime_minutes": row["overtime_minutes"] if "overtime_minutes" in keys and row["overtime_minutes"] is not None else 0,
            "schedule_id": row["schedule_id"] if "schedule_id" in keys else None,
            "schedule_name": row["schedule_name"] if "schedule_name" in keys else None,
        }

class ScheduleModel:
    @staticmethod
    def to_dict(row) -> Dict[str, Any]:
        if not row:
            return {}
        keys = row.keys() if hasattr(row, "keys") else []
        return {
            "id": row["id"] if "id" in keys else None,
            "name": row["name"] if "name" in keys else None,
            "start": row["start_time"] if "start_time" in keys else None,
            "start_time": row["start_time"] if "start_time" in keys else None,
            "end": row["end_time"] if "end_time" in keys else None,
            "end_time": row["end_time"] if "end_time" in keys else None,
            "days_of_week": row["days_of_week"] if "days_of_week" in keys else "1,2,3,4,5",
            "grace_minutes": row["grace_minutes"] if "grace_minutes" in keys else 5,
            "break_minutes": row["break_minutes"] if "break_minutes" in keys else 60,
            "break_is_paid": bool(row["break_is_paid"]) if "break_is_paid" in keys else False,
            "required_minutes": row["required_minutes"] if "required_minutes" in keys else 480,
            "is_overnight": bool(row["is_overnight"]) if "is_overnight" in keys else False,
            "overtime_threshold_daily_minutes": row["overtime_threshold_daily_minutes"] if "overtime_threshold_daily_minutes" in keys else 480,
            "created_at": row["created_at"] if "created_at" in keys else None,
        }

class ShiftAssignmentModel:
    @staticmethod
    def to_dict(row) -> Dict[str, Any]:
        if not row:
            return {}
        keys = row.keys() if hasattr(row, "keys") else []
        return {
            "id": row["id"] if "id" in keys else None,
            "employee_id": row["employee_id"] if "employee_id" in keys else None,
            "employee_name": row["employee_name"] if "employee_name" in keys else (row["name"] if "name" in keys else None),
            "staff_id": row["staff_id"] if "staff_id" in keys else None,
            "schedule_id": row["schedule_id"] if "schedule_id" in keys else None,
            "schedule_name": row["schedule_name"] if "schedule_name" in keys else None,
            "site_id": row["site_id"] if "site_id" in keys else None,
            "effective_from": row["effective_from"] if "effective_from" in keys else None,
            "effective_to": row["effective_to"] if "effective_to" in keys else None,
            "created_at": row["created_at"] if "created_at" in keys else None,
        }

class HolidayModel:
    @staticmethod
    def to_dict(row) -> Dict[str, Any]:
        if not row:
            return {}
        keys = row.keys() if hasattr(row, "keys") else []
        return {
            "id": row["id"] if "id" in keys else None,
            "date": row["date"] if "date" in keys else None,
            "name": row["name"] if "name" in keys else None,
            "scope": row["scope"] if "scope" in keys else "company",
            "site_id": row["site_id"] if "site_id" in keys else None,
            "is_working_day": bool(row["is_working_day"]) if "is_working_day" in keys else False,
            "created_at": row["created_at"] if "created_at" in keys else None,
        }

class PayrollPeriodModel:
    @staticmethod
    def to_dict(row) -> Dict[str, Any]:
        if not row:
            return {}
        keys = row.keys() if hasattr(row, "keys") else []
        return {
            "id": row["id"] if "id" in keys else None,
            "name": row["name"] if "name" in keys else None,
            "start_date": row["start_date"] if "start_date" in keys else None,
            "end_date": row["end_date"] if "end_date" in keys else None,
            "status": row["status"] if "status" in keys else "OPEN",
            "approved_by": row["approved_by"] if "approved_by" in keys else None,
            "approved_at": row["approved_at"] if "approved_at" in keys else None,
            "locked_at": row["locked_at"] if "locked_at" in keys else None,
            "notes": row["notes"] if "notes" in keys else None,
            "created_at": row["created_at"] if "created_at" in keys else None,
        }

class GeofenceModel:
    @staticmethod
    def to_dict(row) -> Dict[str, Any]:
        if not row:
            return {}
        return {
            "id": row["id"],
            "name": row["name"],
            "latitude": row["latitude"],
            "longitude": row["longitude"],
            "radius_meters": row["radius_meters"],
            "work_start_time": row["work_start_time"],
            "updated_at": row["updated_at"]
        }
