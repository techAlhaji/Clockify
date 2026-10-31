/**
 * Clockify — Centralized API Client (api.js)
 * Clean async fetch handlers and error abstraction
 */

const API_BASE = window.location.origin;

function getAuthHeaders(customHeaders = {}) {
  const headers = { ...customHeaders };
  let adminToken = localStorage.getItem("clockify_admin_token") || sessionStorage.getItem("clockify_admin_token");
  if (adminToken) {
    adminToken = adminToken.replace(/^["']|["']$/g, '').trim();
    headers["x-admin-token"] = adminToken;
    headers["Authorization"] = `Bearer ${adminToken}`;
  }
  return headers;
}

const ApiClient = {
  async get(endpoint) {
    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        headers: getAuthHeaders(),
        cache: "no-store"
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail?.message || data.detail || "API request failed");
      }
      return data;
    } catch (err) {
      console.error(`GET ${endpoint} failed:`, err);
      throw err;
    }
  },

  async post(endpoint, payload) {
    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: getAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
        cache: "no-store"
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail?.message || data.detail || "Request failed");
      }
      return data;
    } catch (err) {
      console.error(`POST ${endpoint} failed:`, err);
      throw err;
    }
  },

  async put(endpoint, payload) {
    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: "PUT",
        headers: getAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
        cache: "no-store"
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail?.message || data.detail || "Request failed");
      }
      return data;
    } catch (err) {
      console.error(`PUT ${endpoint} failed:`, err);
      throw err;
    }
  },

  // Authentication Endpoints
  employeeLogin(identifier, pin) {
    return this.post("/api/auth/employee-login", { identifier, pin });
  },

  adminLogin(username, pin) {
    return this.post("/api/auth/admin-login", { username, pin });
  },

  verifyAdmin() {
    return this.get("/api/auth/verify-admin");
  },

  verifyPin(employeeId, pin) {
    return this.post("/api/auth/verify-pin", { employee_id: employeeId, pin });
  },

  // Employee Endpoints
  getEmployees() {
    return this.get("/api/employees");
  },

  getEmployee(id) {
    return this.get(`/api/employees/${id}`);
  },

  // Attendance Endpoints
  getStatus(employeeId) {
    return this.get(`/api/attendance/status/${employeeId}`);
  },

  getHistory(employeeId) {
    return this.get(`/api/attendance/history/${employeeId}`);
  },

  clockIn(employeeId, latitude, longitude, accuracy) {
    return this.post("/api/attendance/clock-in", {
      employee_id: employeeId,
      latitude,
      longitude,
      accuracy
    });
  },

  clockOut(employeeId, latitude, longitude, accuracy) {
    return this.post("/api/attendance/clock-out", {
      employee_id: employeeId,
      latitude,
      longitude,
      accuracy
    });
  },

  syncShift(record) {
    return this.post("/api/attendance/sync-shift", {
      employee_id: record.employee_id,
      date: record.date,
      clock_in_time: record.clock_in_time,
      clock_in_lat: record.clock_in_lat,
      clock_in_lon: record.clock_in_lon,
      clock_in_distance: record.clock_in_distance,
      clock_out_time: record.clock_out_time,
      clock_out_lat: record.clock_out_lat,
      clock_out_lon: record.clock_out_lon,
      clock_out_distance: record.clock_out_distance,
      status: record.status,
      is_late: record.is_late || false,
      notes: record.notes || "Device sync"
    });
  },

  // Admin Endpoints
  getGeofence() {
    return this.get("/api/admin/geofence");
  },

  updateGeofence(payload) {
    return this.put("/api/admin/geofence", payload);
  },

  getAdminMetrics(date) {
    const q = date ? `?date=${encodeURIComponent(date)}` : "";
    return this.get(`/api/admin/metrics${q}`);
  },

  getAdminRecords(date, employeeId, view) {
    const params = new URLSearchParams();
    if (date) params.append("date", date);
    if (employeeId) params.append("employee_id", employeeId);
    if (view) params.append("view", view);
    const q = params.toString() ? `?${params.toString()}` : "";
    return this.get(`/api/admin/records${q}`);
  },

  seedDemo() {
    return this.post("/api/admin/seed-demo-data", {});
  }
};

if (typeof window !== "undefined") {
  window.ApiClient = ApiClient;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = ApiClient;
}
