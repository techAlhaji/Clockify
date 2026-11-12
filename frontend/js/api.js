/**
 * Clockify — Centralized API Client (api.js)
 * Clean async fetch handlers and error abstraction.
 *
 * Sessions are held in sessionStorage only (cleared when the tab closes) and
 * travel exclusively in the Authorization header — never in a URL, never in
 * localStorage.
 */

const API_BASE = window.location.origin;

const ADMIN_TOKEN_KEY = "clockify_admin_token";
const EMPLOYEE_TOKEN_KEY = "clockify_employee_token";

function readSessionToken(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? raw.replace(/^["']|["']$/g, "").trim() : null;
  } catch (e) {
    return null;
  }
}

function getAuthHeaders(customHeaders = {}) {
  const headers = { ...customHeaders };
  const token = readSessionToken(ADMIN_TOKEN_KEY) || readSessionToken(EMPLOYEE_TOKEN_KEY);
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

function buildQuery(params, keys) {
  const query = new URLSearchParams();
  keys.forEach(key => {
    const value = params[key];
    if (value === undefined || value === null || value === "") return;
    if (typeof value === "boolean") {
      if (value) query.append(key, "true");
      return;
    }
    query.append(key, value);
  });
  return query.toString();
}

function extractErrorMessage(data, fallback) {
  const detail = data && data.detail;
  if (!detail) return fallback;
  if (typeof detail === "string") return detail;
  if (typeof detail === "object") return detail.message || detail.error || fallback;
  return fallback;
}

// Escape untrusted text before it is interpolated into innerHTML.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

const ApiClient = {
  // --- Session helpers (sessionStorage, per tab) ---
  setAdminToken(token) {
    sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
  },
  clearAdminToken() {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  },
  hasAdminToken() {
    return Boolean(readSessionToken(ADMIN_TOKEN_KEY));
  },
  setEmployeeToken(token) {
    sessionStorage.setItem(EMPLOYEE_TOKEN_KEY, token);
  },
  clearEmployeeToken() {
    sessionStorage.removeItem(EMPLOYEE_TOKEN_KEY);
  },
  hasEmployeeToken() {
    return Boolean(readSessionToken(EMPLOYEE_TOKEN_KEY));
  },

  async get(endpoint) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: getAuthHeaders(),
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(extractErrorMessage(data, "API request failed"));
    }
    return data;
  },

  async post(endpoint, payload) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: getAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(extractErrorMessage(data, "Request failed"));
    }
    return data;
  },

  async put(endpoint, payload) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: "PUT",
      headers: getAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(extractErrorMessage(data, "Request failed"));
    }
    return data;
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

  // Attendance Endpoints — the employee is identified by the session token
  getStatus(employeeId) {
    return this.get(`/api/attendance/status/${employeeId}`).then(r => {
      // Ensure backward compatibility: if server adds server_time/timezone_offset
      // the client just reads them; existing callers that only check status
      // still work unchanged.
      return r;
    });

  getHistory(employeeId) {
    return this.get(`/api/attendance/history/${employeeId}`);
  },

  clockIn(latitude, longitude, accuracy, clockIntentId) {
    return this.post("/api/attendance/clock-in", { latitude, longitude, accuracy, clock_intent_id: clockIntentId });
  }

  clockOut(latitude, longitude, accuracy) {
    return this.post("/api/attendance/clock-out", { latitude, longitude, accuracy });
  }

  // Admin Endpoints
  getGeofence() {
    return this.get("/api/admin/geofence");
  }

  // Geofence updates require admin authentication; employee portal must never write.
  // A 403 is final — never retry a geofence write from the employee portal.
  updateGeofence(payload) {
    return this.put("/api/admin/geofence", payload);
  },

  getAdminMetrics(filters) {
    // Accept a plain date for backwards compatibility or a {date, start_date,
    // end_date} object.
    const params = typeof filters === "string" || filters == null
      ? { date: filters }
      : filters;
    const query = buildQuery(params, ["date", "start_date", "end_date"]);
    return this.get(`/api/admin/metrics${query ? `?${query}` : ""}`);
  },

  getAdminRecords(filters = {}, employeeId, view) {
    // Accept the new filter object or the legacy (date, employeeId, view)
    // positional form.
    const params = typeof filters === "string" || filters == null
      ? { date: filters, employee_id: employeeId, view }
      : filters;
    const query = buildQuery(params, [
      "date", "start_date", "end_date", "employee_id", "department",
      "status", "late_only", "search", "view", "page", "page_size"
    ]);
    return this.get(`/api/admin/records${query ? `?${query}` : ""}`);
  },

  seedDemo() {
    return this.post("/api/admin/seed-demo-data", {});
  },

  // Authenticated CSV download — credential stays in the header, not the URL
  async exportCsv(filters) {
    const params = typeof filters === "string" || filters == null
      ? { date: filters }
      : filters;
    const query = buildQuery(params, [
      "date", "start_date", "end_date", "employee_id", "department",
      "status", "late_only", "search"
    ]);

    const response = await fetch(`${API_BASE}/api/admin/export/csv${query ? `?${query}` : ""}`, {
      headers: getAuthHeaders(),
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error("Export failed. Please sign in again.");
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const dateLabel = params.start_date || params.date || "all";
    link.download = `attendance_report_${dateLabel}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
};

if (typeof window !== "undefined") {
  window.ApiClient = ApiClient;
  window.escapeHtml = escapeHtml;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = ApiClient;
}
