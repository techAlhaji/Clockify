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
    return this.get(`/api/attendance/status/${employeeId}`);
  },

  getHistory(employeeId) {
    return this.get(`/api/attendance/history/${employeeId}`);
  },

  clockIn(latitude, longitude, accuracy) {
    return this.post("/api/attendance/clock-in", { latitude, longitude, accuracy });
  },

  clockOut(latitude, longitude, accuracy) {
    return this.post("/api/attendance/clock-out", { latitude, longitude, accuracy });
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

  getAdminRecords({ date, view, search, department, status, lateOnly, limit, offset } = {}) {
    const params = new URLSearchParams();
    if (date) params.append("date", date);
    if (view) params.append("view", view);
    if (search) params.append("search", search);
    if (department) params.append("department", department);
    if (status) params.append("status", status);
    if (lateOnly) params.append("late_only", "true");
    if (limit != null) params.append("limit", limit);
    if (offset) params.append("offset", offset);
    const q = params.toString() ? `?${params.toString()}` : "";
    return this.get(`/api/admin/records${q}`);
  },

  seedDemo() {
    return this.post("/api/admin/seed-demo-data", {});
  },

  // Authenticated CSV download — credential stays in the header, not the URL
  async exportCsv({ date = null, search = "", department = "", status = "", lateOnly = false } = {}) {
    const params = new URLSearchParams();
    if (date) params.append("date", date);
    if (search) params.append("search", search);
    if (department) params.append("department", department);
    if (status) params.append("status", status);
    if (lateOnly) params.append("late_only", "true");
    const query = params.toString() ? `?${params.toString()}` : "";

    const response = await fetch(`${API_BASE}/api/admin/export/csv${query}`, {
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
    link.download = `attendance_report_${date || "all"}.csv`;
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
