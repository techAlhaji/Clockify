/**
 * Clockify — Centralized API Client (api.js)
 * Clean async fetch handlers, structured errors and clock-intent idempotency.
 *
 * Sessions are held in sessionStorage only (cleared when the tab closes) and
 * travel exclusively in the Authorization header — never in a URL, never in
 * localStorage.
 */

const API_BASE = window.location.origin;
const API_TIMEOUT_MS = 15000;

const ADMIN_TOKEN_KEY = "clockify_admin_token";
const EMPLOYEE_TOKEN_KEY = "clockify_employee_token";

class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status || 0;
    this.code = options.code || null;
    this.network = Boolean(options.network);
    this.detail = options.detail || null;
  }
}

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

function parseApiError(data, fallback) {
  const detail = data && data.detail;
  if (!detail) return { message: fallback, code: null, detail: null };
  if (typeof detail === "string") return { message: detail, code: null, detail };
  if (typeof detail === "object") {
    return {
      message: detail.message || detail.error || fallback,
      code: detail.error || null,
      detail
    };
  }
  return { message: fallback, code: null, detail: null };
}

// Escape untrusted text before it is interpolated into innerHTML.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

async function apiRequest(method, endpoint, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  const options = {
    method,
    headers: getAuthHeaders(payload !== undefined ? { "Content-Type": "application/json" } : {}),
    cache: "no-store",
    signal: controller.signal
  };

  if (payload !== undefined) {
    options.body = JSON.stringify(payload);
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${endpoint}`, options);
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    throw new ApiError(
      aborted
        ? "The server took too long to respond. Your clock event stays queued on this device."
        : "Cannot reach the Clockify server. Check your connection.",
      { network: true }
    );
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const { message, code, detail } = parseApiError(data, "Request failed");
    throw new ApiError(message, { status: response.status, code, detail });
  }

  return data;
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

  get(endpoint) {
    return apiRequest("GET", endpoint);
  },

  post(endpoint, payload) {
    return apiRequest("POST", endpoint, payload === undefined ? {} : payload);
  },

  put(endpoint, payload) {
    return apiRequest("PUT", endpoint, payload);
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

  /** Server-issued, short-lived, single-use idempotency key (online path). */
  issueIntent(action) {
    return this.post("/api/attendance/intent", { action });
  },

  clockIn(latitude, longitude, accuracy, intentId, clientCapturedAt) {
    return this.post("/api/attendance/clock-in", {
      latitude,
      longitude,
      accuracy,
      client_intent_id: intentId || null,
      client_captured_at: clientCapturedAt || null
    });
  },

  clockOut(latitude, longitude, accuracy, intentId, clientCapturedAt) {
    return this.post("/api/attendance/clock-out", {
      latitude,
      longitude,
      accuracy,
      client_intent_id: intentId || null,
      client_captured_at: clientCapturedAt || null
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
  window.ApiError = ApiError;
  window.escapeHtml = escapeHtml;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = ApiClient;
}
