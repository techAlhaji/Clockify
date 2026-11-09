/**
 * Clockify — Employee Portal Controller (app.js)
 * Live clock, geolocation synchronization, offline-tolerant clock events and
 * queue synchronization. The server remains the source of truth for time,
 * status and geofence validity.
 */

// Application State
const AppState = {
  currentEmployee: null,
  workplace: null,
  currentLocation: null,
  shiftStatus: "NOT_CLOCKED_IN",
  todayRecord: null,
  employeesList: [],
  queue: [],
  actionInFlight: false
};

// Auth Storage Key (identity only; the session token stays in sessionStorage)
const STORAGE_AUTH_KEY = "clockify_authenticated_employee";

const PENDING_MESSAGE = "Pending — will submit when back online";
const CACHE_WORKPLACE = "clockify_cached_workplace";
const CACHE_EMPLOYEES = "clockify_cached_employees";

// DOM Elements
const elements = {
  digitalClock:        document.getElementById('digitalClock'),
  dateDisplay:         document.getElementById('dateDisplay'),

  // Auth Gates & Dashboard Container
  employeeLoginGate:   document.getElementById('employeeLoginGate'),
  employeeDashboard:   document.getElementById('employeeDashboard'),
  employeeLoginForm:   document.getElementById('employeeLoginForm'),
  loginEmployeeSelect: document.getElementById('loginEmployeeSelect'),
  loginIdentifier:     document.getElementById('loginIdentifier'),
  loginPin:            document.getElementById('loginPin'),
  btnLoginSubmit:      document.getElementById('btnLoginSubmit'),
  btnEmployeeLogout:   document.getElementById('btnEmployeeLogout'),

  // Connectivity / Offline queue
  offlineBanner:    document.getElementById('offlineBanner'),
  connectionBadge:  document.getElementById('connectionBadge'),
  syncPanel:        document.getElementById('syncPanel'),
  pendingCount:     document.getElementById('pendingCount'),
  syncList:         document.getElementById('syncList'),
  btnRetryNow:      document.getElementById('btnRetryNow'),

  // Employee Profile Elements
  employeeName:        document.getElementById('employeeName'),
  employeeDept:        document.getElementById('employeeDept'),
  employeeAvatar:      document.getElementById('employeeAvatar'),

  // Radar / Status
  statusBadge:   document.getElementById('statusBadge'),
  distanceValue: document.getElementById('distanceValue'),
  distanceSub:   document.getElementById('distanceSub'),
  radarWrapEl:   document.getElementById('radarWrapEl'),
  radarDot:      document.getElementById('radarDot'),

  // Action Button
  btnAction:      document.getElementById('btnAction'),
  actionBtnText:  document.getElementById('actionBtnText'),

  // Today Summary
  todayClockIn:  document.getElementById('todayClockIn'),
  todayClockOut: document.getElementById('todayClockOut'),
  clockInNote:   document.getElementById('clockInNote'),
  clockOutNote:  document.getElementById('clockOutNote'),

  // History
  historyList:   document.getElementById('historyList'),
  historyCount:  document.getElementById('historyCount'),
  toastContainer: document.getElementById('toastContainer')
};

let syncAttempt = 0;
let syncTimer = null;
let syncInFlight = false;
let pollTimer = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function init() {
  startClock();
  setupEventListeners();
  updateConnectivityUI();
  registerServiceWorker();

  try {
    await ClockQueue.init();
  } catch (err) {
    console.warn("Offline queue unavailable:", err);
  }

  // 1. Workplace perimeter — cache the last known value for offline boots.
  try {
    AppState.workplace = await ApiClient.getGeofence();
    cacheSet(CACHE_WORKPLACE, AppState.workplace);
  } catch (err) {
    AppState.workplace = cacheGet(CACHE_WORKPLACE, null);
    console.warn("Using cached workplace settings:", err);
  }

  // 2. Roster for the login selector — same caching strategy.
  try {
    AppState.employeesList = await ApiClient.getEmployees();
    cacheSet(CACHE_EMPLOYEES, AppState.employeesList);
  } catch (err) {
    AppState.employeesList = cacheGet(CACHE_EMPLOYEES, []);
    console.warn("Using cached employee roster:", err);
  }

  populateEmployeeLoginSelect();
  await refreshQueue();

  // 3. Restore an authenticated session for this tab.
  const authRaw = localStorage.getItem(STORAGE_AUTH_KEY);
  if (authRaw && ApiClient.hasEmployeeToken()) {
    try {
      const savedEmp = JSON.parse(authRaw);
      AppState.currentEmployee = AppState.employeesList.find(e => e.id === savedEmp.id) || savedEmp;
      await showPersonalDashboard();
    } catch (err) {
      showLoginGate();
    }
  } else {
    showLoginGate();
  }

  if (navigator.onLine) flushQueue();

  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (navigator.onLine) flushQueue();
    }, 60000);
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/service-worker.js", { scope: "/" })
      .catch((err) => console.warn("Service worker registration failed:", err));
  });
}

// Populate login selector with roster
function populateEmployeeLoginSelect() {
  if (!elements.loginEmployeeSelect) return;
  const opts = AppState.employeesList.map(e =>
    `<option value="${e.id}" data-staff="${escapeHtml(e.staff_id)}">${escapeHtml(e.name)} — ${escapeHtml(e.department)} (${escapeHtml(e.staff_id)})</option>`
  ).join('');
  elements.loginEmployeeSelect.innerHTML = `<option value="">— Choose your name from roster —</option>` + opts;
}

// Show Personalized Dashboard for active employee
async function showPersonalDashboard() {
  if (elements.employeeLoginGate) elements.employeeLoginGate.style.display = 'none';
  if (elements.employeeDashboard) elements.employeeDashboard.style.display = 'flex';

  renderEmployeeProfile();
  await refreshShiftData();
  await refreshQueue();
  queryLiveLocation();
}

// Show Login Gate when unauthenticated
function showLoginGate() {
  if (elements.employeeLoginGate) elements.employeeLoginGate.style.display = 'block';
  if (elements.employeeDashboard) elements.employeeDashboard.style.display = 'none';
  AppState.currentEmployee = null;
}

// Live Digital Clock
function startClock() {
  function update() {
    const now = new Date();
    elements.digitalClock.textContent = now.toLocaleTimeString([], { hour12: true });
    elements.dateDisplay.textContent = now.toLocaleDateString([], {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });
  }
  update();
  setInterval(update, 1000);
}

// Render Profile
function renderEmployeeProfile() {
  if (!AppState.currentEmployee) return;
  elements.employeeName.textContent = AppState.currentEmployee.name;
  elements.employeeDept.textContent = `${AppState.currentEmployee.department} • ${AppState.currentEmployee.staff_id}`;

  const initials = AppState.currentEmployee.name
    .split(" ")
    .map(n => n[0])
    .join("")
    .substring(0, 2)
    .toUpperCase();
  elements.employeeAvatar.textContent = initials;
}

function getLocalDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getShiftLockKey(employeeId, dateStr = getLocalDateString()) {
  return `clockify_shift_lock_${employeeId}_${dateStr}`;
}

function getShiftLock(employeeId, dateStr = getLocalDateString()) {
  try {
    const raw = localStorage.getItem(getShiftLockKey(employeeId, dateStr));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveShiftLock(employeeId, status, record, dateStr = getLocalDateString()) {
  try {
    const payload = {
      employee_id: employeeId,
      status: status,
      date: dateStr,
      record: record,
      locked_at: new Date().toISOString()
    };
    localStorage.setItem(getShiftLockKey(employeeId, dateStr), JSON.stringify(payload));
  } catch (e) {
    console.error("Failed to save shift lock:", e);
  }
}

// Refresh Shift Status & History — the server is the source of truth.
// The client can no longer write attendance records; local storage is only a
// cache for the current day's UI state.
async function refreshShiftData() {
  if (!AppState.currentEmployee) return;
  const empId = AppState.currentEmployee.id;
  const today = getLocalDateString();

  try {
    const statusData = await ApiClient.getStatus(empId);

    AppState.shiftStatus = statusData.status;
    AppState.todayRecord = statusData.record;

    if (statusData.status === "CLOCKED_IN" || statusData.status === "CLOCKED_OUT") {
      saveShiftLock(empId, statusData.status, statusData.record, today);
    }

    updateActionControls();
    updateTodaySummary();

    const historyData = await ApiClient.getHistory(empId);
    renderHistory(historyData);
  } catch (err) {
    console.error("Failed to refresh shift:", err);

    if (err.status === 401 || (err.message || "").toLowerCase().includes("session")) {
      handleSessionExpired();
      return;
    }

    // Offline: fall back to the cached UI state for this shift.
    const lock = getShiftLock(empId, today);
    if (lock) {
      AppState.shiftStatus = lock.status || "NOT_CLOCKED_IN";
      AppState.todayRecord = lock.record || null;
    }

    updateActionControls();
    updateTodaySummary();

    if (elements.historyList && elements.historyList.children.length === 0) {
      elements.historyList.innerHTML = `
        <div class="empty">
          <div class="empty-msg">Offline — history will refresh when you reconnect.</div>
        </div>`;
    }
  }
}

// ---------------------------------------------------------------------------
// Offline queue helpers
// ---------------------------------------------------------------------------

function queueAvailable() {
  return typeof ClockQueue !== "undefined" && ClockQueue.isSupported();
}

function getPending(action) {
  if (!AppState.currentEmployee) return null;
  return AppState.queue.find((item) =>
    item.employee_id === AppState.currentEmployee.id &&
    item.status === "pending" &&
    (!action || item.action === action)
  ) || null;
}

async function refreshQueue() {
  if (queueAvailable()) {
    try {
      AppState.queue = await ClockQueue.all();
    } catch (err) {
      console.warn("Could not read the offline queue:", err);
      AppState.queue = [];
    }
  }
  renderSyncPanel();
  updateActionControls();
  updateTodaySummary();
}

function renderSyncPanel() {
  if (!elements.syncPanel) return;

  const employeeId = AppState.currentEmployee ? AppState.currentEmployee.id : null;
  const items = AppState.queue
    .filter((item) => employeeId !== null && item.employee_id === employeeId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const pendingAll = AppState.queue.filter((item) => item.status === "pending");
  elements.pendingCount.textContent = pendingAll.length
    ? `${pendingAll.length} pending`
    : "All events synced";
  elements.pendingCount.className = `sync-count${pendingAll.length ? " has-pending" : ""}`;

  elements.syncPanel.hidden = items.length === 0;
  if (!items.length) {
    elements.syncList.innerHTML = "";
    return;
  }

  elements.syncList.innerHTML = items.map((item) => {
    const actionLabel = item.action === "IN" ? "Clock in" : "Clock out";
    const captured = formatDeviceTime(item.client_captured_at);

    if (item.status === "confirmed") {
      const serverTime = item.server_time || formatDeviceTime(item.server_received_at) || "--:--";
      return `
        <div class="sync-item confirmed">
          <div class="sync-item-main">
            <span class="sync-item-title">${actionLabel} · ${escapeHtml(serverTime)}</span>
            <span class="sync-item-sub">
              Confirmed by server${item.duplicate ? " (existing record)" : ""} · captured ${escapeHtml(captured)} on device
            </span>
          </div>
          <span class="sync-tag confirmed">Confirmed</span>
        </div>`;
    }

    if (item.status === "rejected") {
      return `
        <div class="sync-item rejected">
          <div class="sync-item-main">
            <span class="sync-item-title">${actionLabel} · ${escapeHtml(captured)}</span>
            <span class="sync-item-sub">${escapeHtml(item.error || "Rejected by the server.")}</span>
          </div>
          <div class="sync-item-actions">
            <span class="sync-tag rejected">Rejected</span>
            <button type="button" class="sync-dismiss" data-dismiss="${item.intent_id}">Dismiss</button>
          </div>
        </div>`;
    }

    const attemptText = item.attempts
      ? ` · ${item.attempts} attempt${item.attempts === 1 ? "" : "s"}`
      : "";
    return `
      <div class="sync-item pending">
        <div class="sync-item-main">
          <span class="sync-item-title">${actionLabel} · ${escapeHtml(captured)}</span>
          <span class="sync-item-sub">${PENDING_MESSAGE}${attemptText}</span>
        </div>
        <span class="sync-tag pending">Pending</span>
      </div>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Action button & today summary
// ---------------------------------------------------------------------------

function updateActionControls() {
  if (!elements.btnAction) return;

  elements.btnAction.classList.remove("btn-clock-out");

  if (!AppState.currentEmployee) {
    elements.btnAction.disabled = true;
    elements.actionBtnText.textContent = "Sign in to clock in";
    elements.btnAction.onclick = null;
    return;
  }

  const pendingIn = getPending("IN");
  const pendingOut = getPending("OUT");

  if (AppState.shiftStatus === "CLOCKED_OUT") {
    elements.btnAction.classList.add("btn-clock-out");
    elements.actionBtnText.textContent = pendingOut ? "Clock-Out Pending" : "Shift Completed Today";
    elements.btnAction.disabled = true;
    elements.btnAction.onclick = null;
    return;
  }

  if (AppState.shiftStatus === "CLOCKED_IN") {
    elements.btnAction.classList.add("btn-clock-out");
    if (pendingOut) {
      elements.actionBtnText.textContent = "Clock-Out Pending";
      elements.btnAction.disabled = true;
      elements.btnAction.onclick = null;
    } else {
      elements.actionBtnText.textContent = "Clock Out";
      elements.btnAction.disabled = false;
      elements.btnAction.onclick = handleClockOut;
    }
    return;
  }

  if (pendingIn) {
    elements.actionBtnText.textContent = "Clock-In Pending";
    elements.btnAction.disabled = true;
    elements.btnAction.onclick = null;
    return;
  }

  elements.actionBtnText.textContent = "Clock In Now";
  elements.btnAction.disabled = false;
  elements.btnAction.onclick = handleClockIn;
}

function updateTodaySummary() {
  const record = AppState.todayRecord;
  const pendingIn = getPending("IN");
  const pendingOut = getPending("OUT");

  if (record && record.clock_in_time) {
    elements.todayClockIn.textContent = record.clock_in_time;
    setSummaryNote(elements.clockInNote, "Confirmed by server", "confirmed");
  } else if (pendingIn) {
    elements.todayClockIn.textContent = formatDeviceTime(pendingIn.client_captured_at);
    setSummaryNote(elements.clockInNote, PENDING_MESSAGE, "pending");
  } else {
    elements.todayClockIn.textContent = "--:--";
    setSummaryNote(elements.clockInNote, "Not synced yet", "");
  }

  if (record && record.clock_out_time) {
    elements.todayClockOut.textContent = record.clock_out_time;
    setSummaryNote(elements.clockOutNote, "Confirmed by server", "confirmed");
  } else if (pendingOut) {
    elements.todayClockOut.textContent = formatDeviceTime(pendingOut.client_captured_at);
    setSummaryNote(elements.clockOutNote, PENDING_MESSAGE, "pending");
  } else {
    elements.todayClockOut.textContent = "--:--";
    setSummaryNote(elements.clockOutNote, "Not synced yet", "");
  }
}

function setSummaryNote(element, text, kind) {
  if (!element) return;
  element.textContent = text;
  element.className = `summary-note${kind ? ` ${kind}` : ""}`;
}

// Render Attendance History
function renderHistory(records) {
  if (elements.historyCount) {
    elements.historyCount.textContent = records && records.length > 0
      ? `${records.length} record${records.length !== 1 ? 's' : ''}`
      : '0 records';
  }

  if (!records || records.length === 0) {
    elements.historyList.innerHTML = `
      <div class="empty">
        <div class="empty-ic">📅</div>
        <div class="empty-msg">No recent attendance records</div>
      </div>`;
    return;
  }

  elements.historyList.innerHTML = records.map(r => {
    const dateObj = r.date ? new Date(r.date + 'T00:00:00') : null;
    const dayNum  = dateObj ? dateObj.getDate() : '--';
    const dayMon  = dateObj ? dateObj.toLocaleDateString([], { month: 'short' }).toUpperCase() : '---';
    return `
    <div class="h-item" role="listitem">
      <div class="h-left">
        <div class="h-date-box" aria-hidden="true">
          <span class="h-day">${dayNum}</span>
          <span class="h-mon">${dayMon}</span>
        </div>
        <div class="h-info">
          <div class="h-date-str">${escapeHtml(r.date)}</div>
          <div class="h-times">In: ${escapeHtml(r.clock_in_time || 'N/A')}&nbsp;·&nbsp;Out: ${escapeHtml(r.clock_out_time || 'In Progress')}</div>
        </div>
      </div>
      <span class="h-badge ${r.is_late ? 'h-late' : 'h-ontime'}">
        ${r.is_late ? '⏰ Late' : '✓ On Time'}
      </span>
    </div>`;
  }).join('');
}

// Query Live Location & Update Radar
async function queryLiveLocation() {
  elements.statusBadge.className = 'status-pill pill-checking';
  elements.statusBadge.innerHTML = '<span class="pill-dot"></span> Locating GPS…';

  try {
    const pos = await GeoService.getCurrentPosition();
    AppState.currentLocation = pos;
    updateDistanceRadar(pos.latitude, pos.longitude, pos.accuracy);
  } catch (err) {
    elements.statusBadge.className = 'status-pill pill-outside';
    elements.statusBadge.innerHTML = '<span class="pill-dot"></span> GPS Offline';
    elements.distanceValue.textContent = 'GPS Error';
    elements.distanceSub.textContent   = err.message;
  }
}

// Distance Radar Update
function updateDistanceRadar(lat, lon, accuracy) {
  if (!AppState.workplace) {
    elements.statusBadge.className = 'status-pill pill-outside';
    elements.statusBadge.innerHTML = '<span class="pill-dot"></span> Offline';
    elements.distanceValue.textContent = 'Unknown';
    elements.distanceSub.textContent = 'Workplace settings are not cached on this device. Reconnect once to load them.';
    return;
  }

  const dist     = GeoService.calculateDistance(lat, lon, AppState.workplace.latitude, AppState.workplace.longitude);
  const radius   = AppState.workplace.radius_meters;
  const isInside = dist <= radius;

  elements.distanceValue.textContent = `${dist}m away`;
  elements.distanceSub.textContent   = `${AppState.workplace.name} · Radius ${radius}m · GPS ±${accuracy}m`;

  if (isInside) {
    elements.statusBadge.className = 'status-pill pill-inside';
    elements.statusBadge.innerHTML = '<span class="pill-dot"></span> Inside Workplace';
    if (elements.radarWrapEl) elements.radarWrapEl.className = 'radar-wrap is-inside';
    if (elements.radarDot)    elements.radarDot.className    = 'radar-user dot-inside';
  } else {
    elements.statusBadge.className = 'status-pill pill-outside';
    elements.statusBadge.innerHTML = '<span class="pill-dot"></span> Outside Perimeter';
    if (elements.radarWrapEl) elements.radarWrapEl.className = 'radar-wrap is-outside';
    if (elements.radarDot)    elements.radarDot.className    = 'radar-user dot-outside';
  }
}

// ---------------------------------------------------------------------------
// Clock events: persist first, then submit (and retry)
// ---------------------------------------------------------------------------

function newIntentId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function buildIntent(action, location) {
  let intentId = newIntentId();

  // Prefer a short-lived server-issued key while online. Offline (or if that
  // request fails) the locally generated UUID is the idempotency key.
  if (navigator.onLine) {
    try {
      const issued = await ApiClient.issueIntent(action);
      if (issued && issued.intent_id) intentId = issued.intent_id;
    } catch (err) {
      console.warn("Could not obtain a server clock intent; using local UUID.", err);
    }
  }

  return {
    intent_id: intentId,
    employee_id: AppState.currentEmployee.id,
    action,
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.accuracy,
    client_captured_at: new Date(location.timestamp || Date.now()).toISOString(),
    created_at: new Date().toISOString(),
    attempts: 0,
    status: "pending",
    error: null
  };
}

function isRetryableError(err) {
  if (!err || err.network || !err.status) return true;
  if (err.status >= 500) return true;
  if ([408, 425, 429].includes(err.status)) return true;
  if (err.status === 409 && err.code === "INTENT_IN_PROGRESS") return true;
  return false;
}

async function submitClockIntent(item) {
  try {
    const response = item.action === "IN"
      ? await ApiClient.clockIn(
          item.latitude, item.longitude, item.accuracy,
          item.intent_id, item.client_captured_at
        )
      : await ApiClient.clockOut(
          item.latitude, item.longitude, item.accuracy,
          item.intent_id, item.client_captured_at
        );

    if (queueAvailable()) {
      try {
        await ClockQueue.confirm(item.intent_id, response.record, response.duplicate);
      } catch (err) {
        console.warn("Could not mark clock intent confirmed:", err);
      }
    }

    return { ok: true, response };
  } catch (err) {
    const apiError = err instanceof ApiError
      ? err
      : new ApiError(err && err.message ? err.message : "Clock event failed.", {});

    if (isRetryableError(apiError)) {
      if (queueAvailable()) {
        try { await ClockQueue.markAttempt(item.intent_id, apiError.message); } catch (e) { /* ignore */ }
      }
      return { ok: false, retry: true, error: apiError };
    }

    // Terminal rejection (expired window, outside geofence, no open shift...).
    if (queueAvailable()) {
      try { await ClockQueue.reject(item.intent_id, apiError.message); } catch (e) { /* ignore */ }
    }
    return { ok: false, retry: false, error: apiError };
  }
}

function labelForAction(action) {
  return action === "IN" ? "Clock-in" : "Clock-out";
}

// Handle Clock In
async function handleClockIn() {
  if (!AppState.currentEmployee || AppState.actionInFlight) return;
  if (!queueAvailable()) {
    showToast("This browser cannot store clock events offline. Update or enable site storage.", "error");
    return;
  }
  if (getPending("IN")) {
    showToast("Your clock-in is already pending and will submit automatically.", "warning");
    return;
  }

  const empId = AppState.currentEmployee.id;
  const today = getLocalDateString();
  const lock = getShiftLock(empId, today);

  if (AppState.shiftStatus === "CLOCKED_OUT" || (lock && lock.status === "CLOCKED_OUT")) {
    showToast("Shift already completed for today. You cannot clock in again.", "warning");
    AppState.shiftStatus = "CLOCKED_OUT";
    updateActionControls();
    return;
  }

  if (AppState.shiftStatus === "CLOCKED_IN" || (lock && lock.status === "CLOCKED_IN")) {
    showToast("You are already clocked in for today.", "warning");
    AppState.shiftStatus = "CLOCKED_IN";
    updateActionControls();
    return;
  }

  AppState.actionInFlight = true;
  elements.btnAction.disabled = true;
  elements.actionBtnText.textContent = "Verifying GPS Location...";

  try {
    let loc;
    try {
      loc = await GeoService.getCurrentPosition();
    } catch (err) {
      showToast(err.message, "error");
      return;
    }

    AppState.currentLocation = loc;
    updateDistanceRadar(loc.latitude, loc.longitude, loc.accuracy);

    elements.actionBtnText.textContent = "Saving clock-in...";
    const intent = await buildIntent("IN", loc);

    // Persist before the network call: a dropped connection never loses the tap.
    await ClockQueue.put(intent);
    await refreshQueue();

    elements.actionBtnText.textContent = navigator.onLine ? "Clocking In..." : "Saved on device";
    const result = await submitClockIntent(intent);
    await refreshQueue();

    if (result.ok) {
      const record = result.response.record || {};
      const nextStatus = record.clock_out_time ? "CLOCKED_OUT" : "CLOCKED_IN";
      saveShiftLock(empId, nextStatus, record, today);
      AppState.shiftStatus = nextStatus;
      AppState.todayRecord = record;
      updateActionControls();
      updateTodaySummary();

      showToast(
        result.response.duplicate
          ? `Clock-in already on record · ${record.clock_in_time} (server time)`
          : `Arrival verified! Clocked in at ${record.clock_in_time}`,
        "success"
      );
      await refreshShiftData();
    } else if (result.retry) {
      showToast(PENDING_MESSAGE, "warning");
      if (navigator.onLine) {
        syncAttempt += 1;
        scheduleRetry();
      }
    } else {
      showToast(result.error.message, "error");
    }
  } catch (err) {
    showToast(err && err.message ? err.message : "Could not save the clock event.", "error");
  } finally {
    AppState.actionInFlight = false;
    refreshQueue();
  }
}

// Handle Clock Out
async function handleClockOut() {
  if (!AppState.currentEmployee || AppState.actionInFlight) return;
  if (!queueAvailable()) {
    showToast("This browser cannot store clock events offline. Update or enable site storage.", "error");
    return;
  }
  if (getPending("OUT")) {
    showToast("Your clock-out is already pending and will submit automatically.", "warning");
    return;
  }

  const empId = AppState.currentEmployee.id;
  const today = getLocalDateString();
  const lock = getShiftLock(empId, today);

  if (AppState.shiftStatus === "CLOCKED_OUT" || (lock && lock.status === "CLOCKED_OUT")) {
    showToast("Shift already completed for today.", "info");
    AppState.shiftStatus = "CLOCKED_OUT";
    updateActionControls();
    return;
  }

  AppState.actionInFlight = true;
  elements.btnAction.disabled = true;
  elements.actionBtnText.textContent = "Verifying Location...";

  try {
    let loc;
    try {
      loc = await GeoService.getCurrentPosition();
    } catch (err) {
      showToast(err.message, "error");
      return;
    }

    AppState.currentLocation = loc;
    updateDistanceRadar(loc.latitude, loc.longitude, loc.accuracy);

    elements.actionBtnText.textContent = "Saving clock-out...";
    const intent = await buildIntent("OUT", loc);
    await ClockQueue.put(intent);
    await refreshQueue();

    elements.actionBtnText.textContent = navigator.onLine ? "Clocking Out..." : "Saved on device";
    const result = await submitClockIntent(intent);
    await refreshQueue();

    if (result.ok) {
      const record = result.response.record || {};
      saveShiftLock(empId, "CLOCKED_OUT", record, today);
      AppState.shiftStatus = "CLOCKED_OUT";
      AppState.todayRecord = record;
      updateActionControls();
      updateTodaySummary();

      showToast(
        result.response.duplicate
          ? `Clock-out already on record · ${record.clock_out_time} (server time)`
          : `Departure recorded at ${record.clock_out_time}. Shift completed!`,
        "success"
      );
      await refreshShiftData();
    } else if (result.retry) {
      showToast(PENDING_MESSAGE, "warning");
      if (navigator.onLine) {
        syncAttempt += 1;
        scheduleRetry();
      }
    } else {
      showToast(result.error.message, "error");
    }
  } catch (err) {
    showToast(err && err.message ? err.message : "Could not save the clock event.", "error");
  } finally {
    AppState.actionInFlight = false;
    refreshQueue();
  }
}

// ---------------------------------------------------------------------------
// Background sync: exponential backoff on the queue
// ---------------------------------------------------------------------------

async function flushQueue() {
  if (syncInFlight || !queueAvailable()) return;
  if (!navigator.onLine) {
    updateConnectivityUI();
    return;
  }
  if (!AppState.currentEmployee) return;

  const employeeId = AppState.currentEmployee.id;
  syncInFlight = true;
  const delivered = [];
  let needsRetry = false;

  try {
    // Only replay events belonging to the signed-in employee; API calls are
    // authenticated with that employee's session token.
    const pending = (await ClockQueue.pending())
      .filter((item) => item.employee_id === employeeId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    if (!pending.length) {
      syncAttempt = 0;
      await refreshQueue();
      return;
    }

    for (const item of pending) {
      const result = await submitClockIntent(item);
      if (result.ok) {
        delivered.push({ item, response: result.response });
      } else if (result.retry) {
        needsRetry = true;
        break;
      }
    }
  } catch (err) {
    console.warn("Clock queue flush failed:", err);
    needsRetry = true;
  } finally {
    syncInFlight = false;
  }

  await refreshQueue();

  if (delivered.length) {
    syncAttempt = 0;
    const last = delivered[delivered.length - 1];
    const record = last.response.record || {};
    const serverTime = last.item.action === "IN" ? record.clock_in_time : record.clock_out_time;
    showToast(
      last.response.duplicate
        ? `${labelForAction(last.item.action)} already recorded by server · ${serverTime}`
        : `${labelForAction(last.item.action)} confirmed by server · ${serverTime}`,
      "success"
    );
    await refreshShiftData();
  }

  if (needsRetry && navigator.onLine) {
    syncAttempt += 1;
    scheduleRetry();
  }
}

function scheduleRetry() {
  if (syncTimer) clearTimeout(syncTimer);

  const attempt = Math.min(syncAttempt, 5);
  const delay = Math.min(60000, 2000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 750);

  syncTimer = setTimeout(() => {
    syncTimer = null;
    if (navigator.onLine) flushQueue();
  }, delay);
}

function updateConnectivityUI() {
  const online = navigator.onLine;

  if (elements.offlineBanner) elements.offlineBanner.hidden = online;
  if (elements.connectionBadge) {
    elements.connectionBadge.textContent = online ? "Online" : "Offline";
    elements.connectionBadge.className = `conn-pill ${online ? "online" : "offline"}`;
  }
}

// Event Listeners & Auth Handlers
function setupEventListeners() {
  // 1. Selector dropdown changes: auto-fill Staff ID
  if (elements.loginEmployeeSelect) {
    elements.loginEmployeeSelect.addEventListener('change', (e) => {
      const selectedId = e.target.value;
      if (selectedId) {
        const emp = AppState.employeesList.find(x => x.id === parseInt(selectedId));
        if (emp && elements.loginIdentifier) {
          elements.loginIdentifier.value = emp.staff_id;
        }
        if (elements.loginPin) elements.loginPin.focus();
      }
    });
  }

  // 2. Employee Login Form submission
  if (elements.employeeLoginForm) {
    elements.employeeLoginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const identifier = (elements.loginIdentifier?.value || '').trim();
      const pin = (elements.loginPin?.value || '').trim();
      const selectVal = elements.loginEmployeeSelect?.value;

      if (!identifier && !selectVal) {
        showToast('Please select your profile or enter your Staff ID.', 'error');
        return;
      }

      if (!pin) {
        showToast('Please enter your 4-digit security PIN.', 'error');
        return;
      }

      try {
        elements.btnLoginSubmit.disabled = true;
        elements.btnLoginSubmit.textContent = 'Verifying Credentials...';

        let targetIdentifier = identifier;
        if (!targetIdentifier && selectVal) {
          const emp = AppState.employeesList.find(x => x.id === parseInt(selectVal));
          if (emp) targetIdentifier = emp.staff_id;
        }

        const res = await ApiClient.employeeLogin(targetIdentifier, pin);
        ApiClient.setEmployeeToken(res.token);
        AppState.currentEmployee = res.employee;
        localStorage.setItem(STORAGE_AUTH_KEY, JSON.stringify(res.employee));

        showToast(`Welcome, ${res.employee.name}!`, 'success');
        await showPersonalDashboard();
        flushQueue();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        elements.btnLoginSubmit.disabled = false;
        elements.btnLoginSubmit.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
          Sign In to My Dashboard
        `;
      }
    });
  }

  // 3. Employee Logout
  if (elements.btnEmployeeLogout) {
    elements.btnEmployeeLogout.addEventListener('click', () => {
      localStorage.removeItem(STORAGE_AUTH_KEY);
      ApiClient.clearEmployeeToken();
      if (elements.loginPin) elements.loginPin.value = '';
      showLoginGate();
      refreshQueue();
      showToast('You have securely signed out of your portal.', 'info');
    });
  }

  // 4. Offline queue controls
  if (elements.btnRetryNow) {
    elements.btnRetryNow.addEventListener('click', () => {
      if (!navigator.onLine) {
        showToast("Still offline — pending events retry automatically when you reconnect.", "warning");
        return;
      }
      syncAttempt = 0;
      flushQueue();
    });
  }

  if (elements.syncList) {
    elements.syncList.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-dismiss]');
      if (!button) return;
      try {
        await ClockQueue.remove(button.getAttribute('data-dismiss'));
      } catch (err) {
        console.warn("Could not dismiss queue item:", err);
      }
      await refreshQueue();
    });
  }

  // 5. Connectivity events
  window.addEventListener('online', () => {
    updateConnectivityUI();
    syncAttempt = 0;
    showToast("Back online — submitting queued clock events…", "info");
    flushQueue();
  });

  window.addEventListener('offline', () => {
    updateConnectivityUI();
    showToast("You're offline. Clock events are saved on this device.", "warning");
  });
}

function handleSessionExpired() {
  ApiClient.clearEmployeeToken();
  localStorage.removeItem(STORAGE_AUTH_KEY);
  showLoginGate();
  showToast('Your session expired. Please sign in again.', 'warning');
}

function getInitials(name) {
  return (name || '?').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function formatDeviceTime(value) {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour12: true });
}

function cacheGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function cacheSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    /* storage may be unavailable; the app still works online */
  }
}

// Toast Notifications
const TOAST_ICONS = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="t-icon">${TOAST_ICONS[type] || 'ℹ'}</div>
    <span></span>
  `;
  toast.querySelector('span').textContent = message;
  elements.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(110%)';
    toast.style.transition = 'all .35s cubic-bezier(.4,0,1,1)';
    setTimeout(() => toast.remove(), 360);
  }, 4500);
}

// Run on page load
document.addEventListener("DOMContentLoaded", init);
