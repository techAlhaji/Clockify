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
    case 1:
      return "Location permission denied. Please allow GPS access in your browser settings.";
    case 2:
      return "GPS location signal unavailable. Ensure your device location is toggled ON.";
    case 3:
      return "GPS request timed out. Please try again in an area with clear signal.";
    default:
      return "Unable to retrieve device location.";
  }
}

// Python round(value, 2) rounds the exact binary float with ties to even.
// Decimal half-cent values can otherwise disagree with JavaScript toFixed().
function roundMeters(value) {
  if (!Number.isFinite(value) || value === 0) return value;
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, Math.abs(value));
  const bits = buffer.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const significand = exponent === 0 ? fraction : fraction + (1n << 52n);
  const power = (exponent === 0 ? 1 : exponent) - 1023 - 52;
  let numerator = significand * 100n;
  const denominator = power < 0 ? 1n << BigInt(-power) : 1n;
  if (power >= 0) numerator <<= BigInt(power);
  let cents = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator ||
      (remainder * 2n === denominator && cents % 2n !== 0n)) cents += 1n;
  return Math.sign(value) * Number(cents) / 100;
}

const GeoService = {
  // Calculate geodesic distance using Haversine formula on client
  calculateDistance(lat1, lon1, lat2, lon2) {
    return roundMeters(this.calculateRawDistance(lat1, lon1, lat2, lon2));
  },

  calculateRawDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // meters
    const toRad = deg => deg * (Math.PI / 180);

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  },

  // Match verify_geofence(): round distance first, then add unrounded accuracy.
  // The server supplies maxAccuracy; missing configuration cannot verify presence.
  verifyGeofence(latitude, longitude, officeLat, officeLon, radius, accuracy, maxAccuracy) {
    const distance = this.calculateDistance(latitude, longitude, officeLat, officeLon);
    let reason = "ACCURACY_MISSING";
    let effectiveDistance = null;
    if (typeof accuracy === "number" && Number.isFinite(accuracy)) {
      effectiveDistance = roundMeters(distance + Math.max(accuracy, 0));
      if (accuracy < 0 || !Number.isFinite(maxAccuracy) || accuracy > maxAccuracy) {
        reason = "ACCURACY_TOO_LOW";
      } else {
        reason = effectiveDistance <= radius ? "INSIDE" : "OUTSIDE_GEOFENCE";
      }
    }
    return { distance, effectiveDistance, isInside: reason === "INSIDE", reason };
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
            accuracy,
            timestamp: position.timestamp,
            lowAccuracy: accuracy > ACCURACY_WARNING_THRESHOLD_M
          });
        },
        error => {
          const geoError = new Error(mapGeoError(error));
          geoError.code = error.code;
          reject(geoError);
        },
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
          accuracy,
          timestamp: pos.timestamp,
          lowAccuracy: accuracy > ACCURACY_WARNING_THRESHOLD_M
        });
      },
      error => {
        if (errorCallback) {
          const geoError = new Error(mapGeoError(error));
          geoError.code = error.code;
          errorCallback(geoError);
        }
      },
      GEO_OPTIONS
    );
  },

  // Stop a watcher started by watchPosition/watchDistanceToOffice.
  clearWatch(watchId) {
    if (watchId === null || watchId === undefined) return;
    if ("geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchId);
    }
  },

  // Real-time distance updater: watches position and reports live distance
  // to the office, whether the user is inside the geofence, and accuracy status.
  //
  // options.minIntervalMs       — minimum time between updates (default: every fix)
  // options.minMovementMeters   — emit early when the device moved at least this far
  //
  // A sample is emitted when either the interval elapsed or the movement
  // threshold was crossed, so a stationary device does not spam the UI and a
  // walking employee still gets prompt updates.
  watchDistanceToOffice(officeLat, officeLon, radiusMeters, onUpdate, options = {}) {
    if (!("geolocation" in navigator)) {
      onUpdate({ error: "Geolocation is not supported by your browser or device.", code: null });
      return null;
    }

    const minIntervalMs = Number(options.minIntervalMs) || 0;
    const minMovementMeters = Number(options.minMovementMeters) || 0;
    let lastEmitAt = 0;
    let lastLat = null;
    let lastLon = null;

    return navigator.geolocation.watchPosition(
      position => {
        const { latitude, longitude, accuracy } = position.coords;
        const now = Date.now();

        if (lastLat !== null) {
          const elapsed = now - lastEmitAt;
          const moved = this.calculateRawDistance(latitude, longitude, lastLat, lastLon);
          if (elapsed < minIntervalMs && moved < minMovementMeters) return;
        }

        lastEmitAt = now;
        lastLat = latitude;
        lastLon = longitude;

        const verification = this.verifyGeofence(
          latitude, longitude, officeLat, officeLon, radiusMeters, accuracy, options.maxAccuracy
        );
        onUpdate({
          latitude,
          longitude,
          accuracy,
          timestamp: position.timestamp,
          ...verification,
          lowAccuracy: accuracy > ACCURACY_WARNING_THRESHOLD_M
        });
      },
      error => {
        // The first fix after an error must restore the UI immediately.
        lastLat = null;
        onUpdate({ error: mapGeoError(error), code: error.code });
      },
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
}
