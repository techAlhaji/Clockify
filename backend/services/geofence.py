import math
from typing import Any, Dict

from backend.config import MAX_ALLOWED_GPS_ACCURACY_METERS


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculate the great circle distance between two points
    on the earth (specified in decimal degrees) using the Haversine formula.
    Returns distance in meters.
    """
    # Earth radius in meters
    EARTH_RADIUS_METERS = 6371000.0

    # Convert decimal degrees to radians
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    # Haversine formula
    a = (math.sin(delta_phi / 2.0) ** 2 +
         math.cos(phi1) * math.cos(phi2) * (math.sin(delta_lambda / 2.0) ** 2))

    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    distance = EARTH_RADIUS_METERS * c

    return round(distance, 2)


def verify_geofence(
    user_lat: float,
    user_lon: float,
    office_lat: float,
    office_lon: float,
    allowed_radius: float,
    gps_accuracy: float = None,
    max_accuracy: float = MAX_ALLOWED_GPS_ACCURACY_METERS
) -> Dict[str, Any]:
    """
    Verify that a reported position is inside the workplace perimeter.

    A fix is only trusted when the reported accuracy is present and within
    ``max_accuracy``. The comparison uses the worst-case position
    (``distance + accuracy``), so an imprecise fix can never be accepted as
    proof of presence just because its centre point happens to fall inside.

    ``reason`` is one of: INSIDE, OUTSIDE_GEOFENCE, ACCURACY_MISSING,
    ACCURACY_TOO_LOW.
    """
    distance = haversine_distance(user_lat, user_lon, office_lat, office_lon)
    result: Dict[str, Any] = {
        "is_inside": False,
        "distance_meters": distance,
        "allowed_radius_meters": allowed_radius,
        "gps_accuracy_meters": gps_accuracy,
        "max_allowed_accuracy_meters": max_accuracy,
        "difference_meters": round(distance - allowed_radius, 2) if distance > allowed_radius else 0.0,
    }

    if gps_accuracy is None:
        result["reason"] = "ACCURACY_MISSING"
        result["effective_distance_meters"] = None
        return result

    try:
        accuracy = float(gps_accuracy)
    except (TypeError, ValueError):
        result["reason"] = "ACCURACY_MISSING"
        result["effective_distance_meters"] = None
        return result

    if accuracy < 0 or accuracy > max_accuracy:
        result["reason"] = "ACCURACY_TOO_LOW"
        result["effective_distance_meters"] = round(distance + max(accuracy, 0.0), 2)
        return result

    effective_distance = round(distance + accuracy, 2)
    is_inside = effective_distance <= allowed_radius

    result["effective_distance_meters"] = effective_distance
    result["is_inside"] = is_inside
    result["reason"] = "INSIDE" if is_inside else "OUTSIDE_GEOFENCE"
    return result
