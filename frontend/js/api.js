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
  },

  // Schedules & Shifts
  getSchedules() {
    return this.get("/api/admin/schedules");
  },

  createSchedule(payload) {
    return this.post("/api/admin/schedules", payload);
  },

  updateSchedule(id, payload) {
    return this.put(`/api/admin/schedules/${id}`, payload);
  },

  deleteSchedule(id) {
    return this.delete ? this.delete(`/api/admin/schedules/${id}`) : fetch(`${API_BASE}/api/admin/schedules/${id}`, { method: "DELETE", headers: getAuthHeaders() }).then(r => r.json());
  },

  getShiftAssignments(employeeId) {
    const q = employeeId ? `?employee_id=${employeeId}` : "";
    return this.get(`/api/admin/shift-assignments${q}`);
  },

  createShiftAssignment(payload) {
    return this.post("/api/admin/shift-assignments", payload);
  },

  getHolidays() {
    return this.get("/api/admin/holidays");
  },

  createHoliday(payload) {
    return this.post("/api/admin/holidays", payload);
  },

  // Timesheets (Daily, Weekly, Monthly)
  getTimesheets(period = "daily", date = null, employeeId = null, department = null) {
    const params = new URLSearchParams();
    if (period) params.append("period", period);
    if (date) params.append("date", date);
    if (employeeId) params.append("employee_id", employeeId);
    if (department) params.append("department", department);
    return this.get(`/api/admin/timesheets?${params.toString()}`);
  },

  // Payroll Management & Export
  getPayrollPeriods() {
    return this.get("/api/admin/payroll/periods");
  },

  createPayrollPeriod(payload) {
    return this.post("/api/admin/payroll/periods", payload);
  },

  approvePayrollPeriod(id) {
    return this.post(`/api/admin/payroll/periods/${id}/approve`, {});
  },

  lockPayrollPeriod(id) {
    return this.post(`/api/admin/payroll/periods/${id}/lock`, {});
  },

  async exportPayroll(startDate, endDate, format = "csv", periodId = null) {
    const params = new URLSearchParams();
    if (startDate) params.append("start_date", startDate);
    if (endDate) params.append("end_date", endDate);
    if (periodId) params.append("period_id", periodId);
    params.append("format", format);

    const response = await fetch(`${API_BASE}/api/admin/payroll/export?${params.toString()}`, {
      headers: getAuthHeaders(),
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error("Payroll export failed. Please verify credentials.");
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `payroll_export_${startDate || "period"}.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },

  // Authenticated CSV download — credential stays in the header, not the URL
  async exportCsv(date) {
    const params = new URLSearchParams();
    if (date) params.append("date", date);
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
