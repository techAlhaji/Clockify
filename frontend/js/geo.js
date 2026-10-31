/**
 * Clockify — Geolocation & Geofencing Client (geo.js)
 * HTML5 Geolocation API wrapper with accuracy verification and distance math
 */

const ACCURACY_WARNING_THRESHOLD_M = 50;

const GEO_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 10000,
  maximumAge: 0
};

// Shared error-code -> readable message mapping, used by every geolocation call
function mapGeoError(error) {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return "Location permission denied. Please allow GPS access in your browser settings.";
    case error.POSITION_UNAVAILABLE:
      return "GPS location signal unavailable. Ensure your device location is toggled ON.";
    case error.TIMEOUT:
      return "GPS request timed out. Please try again in an area with clear signal.";
    default:
      return "Unable to retrieve device location.";
  }
}

const GeoService = {
  // Calculate geodesic distance using Haversine formula on client
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // meters
    const toRad = deg => (deg * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
  },

  // Get current device position with high accuracy (one-shot)
  getCurrentPosition() {
    return new Promise((resolve, reject) => {
      if (!("geolocation" in navigator)) {
        return reject(new Error("Geolocation is not supported by your browser or device."));
      }

      navigator.geolocation.getCurrentPosition(
        position => {
          const { latitude, longitude, accuracy } = position.coords;
          resolve({
            latitude,
            longitude,
            accuracy: Math.round(accuracy),
            timestamp: position.timestamp,
            lowAccuracy: accuracy > ACCURACY_WARNING_THRESHOLD_M
          });
        },
        error => reject(new Error(mapGeoError(error))),
        GEO_OPTIONS
      );
    });
  },

  // Alias matching the team's API contract (getUserLocation), in case app.js
  // calls it by this name instead of getCurrentPosition
  getUserLocation() {
    return this.getCurrentPosition();
  },

  // Continuous location watcher — raw position only, no office comparison.
  // Use watchDistanceToOffice() below when you need live distance/geofence status.
  watchPosition(callback, errorCallback) {
    if (!("geolocation" in navigator)) {
      if (errorCallback) errorCallback(new Error("Geolocation is not supported by your browser or device."));
      return null;
    }

    return navigator.geolocation.watchPosition(
      pos => {
        const { latitude, longitude, accuracy } = pos.coords;
        callback({
          latitude,
          longitude,
          accuracy: Math.round(accuracy),
          lowAccuracy: accuracy > ACCURACY_WARNING_THRESHOLD_M
        });
      },
      error => {
        if (errorCallback) errorCallback(new Error(mapGeoError(error)));
      },
      GEO_OPTIONS
    );
  },

  // Real-time distance updater: watches position and reports live distance
  // to the office, whether the user is inside the geofence, and accuracy status.
  // officeLat/officeLon/radiusMeters come from the admin-configured geofence.
  // onUpdate receives either an error object or a full status object every tick.
  watchDistanceToOffice(officeLat, officeLon, radiusMeters, onUpdate) {
    if (!("geolocation" in navigator)) {
      onUpdate({ error: "Geolocation is not supported by your browser or device." });
      return null;
    }

    return navigator.geolocation.watchPosition(
      position => {
        const { latitude, longitude, accuracy } = position.coords;
        const distance = this.calculateDistance(latitude, longitude, officeLat, officeLon);

        onUpdate({
          latitude,
          longitude,
          accuracy: Math.round(accuracy),
          distance,
          isInside: distance <= radiusMeters,
          lowAccuracy: accuracy > ACCURACY_WARNING_THRESHOLD_M
        });
      },
      error => onUpdate({ error: mapGeoError(error) }),
      GEO_OPTIONS
    );
  }
};

// Expose globally on window for browser scripts, and support module exports if bundled
if (typeof window !== "undefined") {
  window.GeoService = GeoService;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = GeoService;
}