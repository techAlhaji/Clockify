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
        emp_name = row["name"] if "name" in row.keys() else (row["employee_name"] if "employee_name" in row.keys() else None)
        staff_id = row["staff_id"] if "staff_id" in row.keys() else None
        dept = row["department"] if "department" in row.keys() else None
        return {
            "id": row["id"],
            "employee_id": row["employee_id"],
            "name": emp_name,
            "employee_name": emp_name,
            "staff_id": staff_id,
            "department": dept,
            "date": row["date"],
            "clock_in_time": row["clock_in_time"],
            "clock_in_lat": row["clock_in_lat"],
            "clock_in_lon": row["clock_in_lon"],
            "clock_in_distance": row["clock_in_distance"],
            "clock_out_time": row["clock_out_time"],
            "clock_out_lat": row["clock_out_lat"],
            "clock_out_lon": row["clock_out_lon"],
            "clock_out_distance": row["clock_out_distance"],
            "status": row["status"],
            "is_late": bool(row["is_late"]),
            "notes": row["notes"]
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
