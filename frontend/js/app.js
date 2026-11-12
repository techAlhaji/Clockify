/**
 * Clockify — Employee Portal Controller (app.js)
 * Live clock, geolocation synchronization, clock-in/out logic, and UI updates
 */

// Application State
const AppState = {
  currentEmployee: null,
  workplace: null,
  currentLocation: null,
  shiftStatus: "NOT_CLOCKED_IN",
  todayRecord: null,
  employeesList: []
};

// Auth Storage Key
const STORAGE_AUTH_KEY = "clockify_authenticated_employee";

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

  // Employee Profile Elements
  employeeName:        document.getElementById('employeeName'),
  employeeDept:        document.getElementById('employeeDept'),
  employeeAvatar:      document.getElementById('employeeAvatar'),

  // Radar / Status — new v3 IDs
  statusBadge:   document.getElementById('statusBadge'),
  statusPulse:   document.getElementById('statusPulse'),
  distanceValue: document.getElementById('distanceValue'),
  distanceSub:   document.getElementById('distanceSub'),
  radarFreshness: document.getElementById('radarFreshness'),
  radarWrapEl:   document.getElementById('radarWrapEl'),
  radarDot:      document.getElementById('radarDot'),
  btnRefreshLocation: document.getElementById('btnRefreshLocation'),

  // Action Button
  btnAction:      document.getElementById('btnAction'),
  actionBtnText:  document.getElementById('actionBtnText'),

  // Today Summary
  todayClockIn:  document.getElementById('todayClockIn'),
  todayClockOut: document.getElementById('todayClockOut'),

  // History
  historyList:   document.getElementById('historyList'),
  historyCount:  document.getElementById('historyCount'),
  toastContainer: document.getElementById('toastContainer')
};

// Live geofence radar tuning
const GEO_EMIT_INTERVAL_MS = 30000;
const GEO_MOVE_THRESHOLD_M = 25;
const GEO_STALE_AFTER_MS = 90000;
const GEO_FRESHNESS_TICK_MS = 5000;

let geoWatchId = null;
let geoRequestSeq = 0;
let geoFreshnessTimer = null;
let geoLastFixAt = 0;
let geoState = "idle";
let geoRefreshInFlight = false;
let geoRefreshGeneration = 0;
let geoLifecycleGeneration = 0;
let geoError = null;

// Initialize Application
async function init() {
  startClock();
  setupEventListeners();

  try {
    // 1. Fetch Geofence Settings
    // The server is the only source of truth for the workplace perimeter.
    AppState.workplace = await ApiClient.getGeofence();

    // 2. Fetch Employees List to populate login selector
    AppState.employeesList = await ApiClient.getEmployees();
    populateEmployeeLoginSelect();

    // 3. Check for Authenticated Employee Session
    const authRaw = localStorage.getItem(STORAGE_AUTH_KEY);
    if (authRaw && ApiClient.hasEmployeeToken()) {
      try {
        const savedEmp = JSON.parse(authRaw);
        // Sync with latest employee data from backend if present
        AppState.currentEmployee = AppState.employeesList.find(e => e.id === savedEmp.id) || savedEmp;
        await showPersonalDashboard();
      } catch (err) {
        showLoginGate();
      }
    } else {
      showLoginGate();
    }
  } catch (err) {
    showToast(err.message, "error");
  }
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
  startLocationWatch();
}

// Show Login Gate when unauthenticated
function showLoginGate() {
  if (elements.employeeLoginGate) elements.employeeLoginGate.style.display = 'block';
  if (elements.employeeDashboard) elements.employeeDashboard.style.display = 'none';
  AppState.currentEmployee = null;
  stopLocationWatch("signedOut");
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
  const employee = AppState.currentEmployee;
  const empId = employee.id;
  const today = getLocalDateString();

  try {
    const statusData = await ApiClient.getStatus(empId);
    if (employee !== AppState.currentEmployee) return;

    AppState.shiftStatus = statusData.status;
    AppState.todayRecord = statusData.record;

    if (statusData.status === "CLOCKED_IN" || statusData.status === "CLOCKED_OUT") {
      saveShiftLock(empId, statusData.status, statusData.record, today);
    }

    updateActionControls();
    updateTodaySummary();

    if (AppState.shiftStatus === "CLOCKED_OUT") {
      stopLocationWatch("complete");
    }

    const historyData = await ApiClient.getHistory(empId);
    if (employee !== AppState.currentEmployee) return;
    renderHistory(historyData);
  } catch (err) {
    console.error("Failed to refresh shift:", err);
    if ((err.message || "").toLowerCase().includes("session")) {
      handleSessionExpired();
    }
  }
}

// Update Action Button State
function updateActionControls() {
  if (!elements.btnAction) return;

  elements.btnAction.classList.remove("btn-clock-out");

  if (AppState.shiftStatus === "CLOCKED_OUT") {
    elements.actionBtnText.textContent = "Shift Completed Today";
    elements.btnAction.disabled = true;
    elements.btnAction.onclick = null;
  } else if (AppState.shiftStatus === "CLOCKED_IN") {
    elements.actionBtnText.textContent = "Clock Out";
    elements.btnAction.disabled = false;
    elements.btnAction.classList.add("btn-clock-out");
    elements.btnAction.onclick = handleClockOut;
  } else {
    elements.actionBtnText.textContent = "Clock In Now";
    elements.btnAction.disabled = false;
    elements.btnAction.onclick = handleClockIn;
  }
}

// Update Today Summary Cards
function updateTodaySummary() {
  if (AppState.todayRecord) {
    elements.todayClockIn.textContent = AppState.todayRecord.clock_in_time || "--:--";
    elements.todayClockOut.textContent = AppState.todayRecord.clock_out_time || "--:--";
  } else {
    elements.todayClockIn.textContent = "--:--";
    elements.todayClockOut.textContent = "--:--";
  }
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

// ---------------------------------------------------------------------------
// Live geofence radar
// ---------------------------------------------------------------------------

// Each call returns a frozen snapshot; consumers cannot mutate app state.
function getLocationSnapshot() {
  const sample = AppState.currentLocation;
  const ageMs = sample ? Math.max(0, Date.now() - sample.timestamp) : null;
  const fresh = geoState === "live" && ageMs !== null && ageMs < GEO_STALE_AFTER_MS;
  return Object.freeze({
    sample: sample ? Object.freeze({ ...sample }) : null,
    state: geoState, error: geoError, ageMs, fresh,
    verifiedPresence: fresh && sample.isInside
  });
}

function publishLocationState() {
  window.dispatchEvent(new CustomEvent("clockify:location-update", { detail: getLocationSnapshot() }));
}

window.ClockifyLocation = Object.freeze({ getSnapshot: getLocationSnapshot });

function resetRadarPosition() {
  if (elements.radarWrapEl) elements.radarWrapEl.className = "radar-wrap";
  if (elements.radarDot) elements.radarDot.className = "radar-user";
}

function setGeoBadge(label, pillClass) {
  if (!elements.statusBadge) return;
  elements.statusBadge.className = `status-pill ${pillClass}`;
  elements.statusBadge.innerHTML = `<span class="pill-dot"></span> ${escapeHtml(label)}`;
}

function setGeoPulse(stateClass) {
  if (!elements.statusPulse) return;
  elements.statusPulse.className = stateClass
    ? `pulse-indicator ${stateClass}`
    : "pulse-indicator";
}

function formatFixAge(ms) {
  if (!Number.isFinite(ms) || ms < 5000) return "just now";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function renderGeoFreshness() {
  const el = elements.radarFreshness;
  if (!el) return;
  el.classList.remove("is-stale", "is-error");

  if (geoState === "denied") {
    el.textContent = "Live tracking stopped — location permission denied";
    el.classList.add("is-error");
    return;
  }
  if (geoState === "paused") {
    el.textContent = "Live tracking paused while this tab is hidden";
    el.classList.add("is-stale");
    return;
  }
  if (geoState === "signedOut" || geoState === "idle") {
    el.textContent = "No live location tracking";
    return;
  }
  if (geoState === "complete") {
    el.textContent = "Live tracking stopped — shift complete";
    return;
  }
  if (!geoLastFixAt) {
    if (geoState === "stale") {
      el.textContent = "No GPS fix yet — retrying automatically";
      el.classList.add("is-stale");
    } else {
      el.textContent = "Waiting for the first GPS fix…";
    }
    return;
  }

  const age = Math.max(0, Date.now() - geoLastFixAt);
  if (geoState === "stale") {
    el.textContent = `Signal lost — last GPS fix ${formatFixAge(age)} ago`;
    el.classList.add("is-stale");
    return;
  }

  const isStale = age >= GEO_STALE_AFTER_MS;
  el.textContent = `Last GPS fix ${formatFixAge(age)} ago${isStale ? " · stale" : ""}`;
  if (isStale) {
    el.classList.add("is-stale");
    geoState = "stale";
    setGeoBadge("GPS Stale", "pill-stale");
    setGeoPulse("outside");
    resetRadarPosition();
    publishLocationState();
  }
}

function startGeoFreshnessTicker() {
  if (geoFreshnessTimer !== null) return;
  geoFreshnessTimer = setInterval(renderGeoFreshness, GEO_FRESHNESS_TICK_MS);
  renderGeoFreshness();
}

function clearLocationWatch() {
  geoRequestSeq += 1;
  if (geoWatchId !== null) {
    GeoService.clearWatch(geoWatchId);
  }
  geoWatchId = null;
  if (geoFreshnessTimer !== null) {
    clearInterval(geoFreshnessTimer);
    geoFreshnessTimer = null;
  }
}

function showGeoLocating(message = "Locating GPS…") {
  geoState = "locating";
  setGeoBadge("Locating GPS…", "pill-checking");
  setGeoPulse("");
  if (!geoLastFixAt) {
    elements.distanceValue.textContent = "Calculating…";
    elements.distanceSub.textContent = "Acquiring device satellite position…";
  }
  if (elements.radarWrapEl) elements.radarWrapEl.className = "radar-wrap";
  if (elements.radarFreshness) {
    elements.radarFreshness.textContent = message;
    elements.radarFreshness.classList.remove("is-stale", "is-error");
  }
}

function applyGeoFix(loc) {
  if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) return;
  if (!AppState.currentEmployee || document.hidden || AppState.shiftStatus === "CLOCKED_OUT") return;

  geoLastFixAt = Number(loc.timestamp) || Date.now();
  geoState = "live";
  geoError = null;
  AppState.currentLocation = Object.freeze({ ...loc, timestamp: geoLastFixAt,
    ...GeoService.verifyGeofence(loc.latitude, loc.longitude, AppState.workplace.latitude,
      AppState.workplace.longitude, AppState.workplace.radius_meters, loc.accuracy,
      AppState.workplace.max_allowed_accuracy_meters)
  });
  updateDistanceRadar(loc.latitude, loc.longitude, loc.accuracy);
  renderGeoFreshness();
  publishLocationState();
}

function applyGeoFailure(errLike) {
  const message = typeof errLike === "string"
    ? errLike
    : (errLike && errLike.message) || "Unable to retrieve device location.";
  const code = errLike && typeof errLike === "object" ? errLike.code : undefined;
  geoError = message;
  resetRadarPosition();
  const denied = code === 1 || /denied|permission/i.test(message);

  if (denied) {
    clearLocationWatch();
    geoState = "denied";
    setGeoBadge("GPS Denied", "pill-denied");
    setGeoPulse("outside");
    if (elements.radarWrapEl) elements.radarWrapEl.className = "radar-wrap is-denied";
    elements.distanceValue.textContent = "Location off";
    elements.distanceSub.textContent =
      `${message} Allow location access for this site in your browser settings, then choose Retry location.`;
    renderGeoFreshness();
    publishLocationState();
    return;
  }

  geoState = "stale";
  setGeoBadge("GPS Stale", "pill-stale");
  setGeoPulse("outside");
  if (!geoLastFixAt) {
    elements.distanceValue.textContent = "GPS Unavailable";
    elements.distanceSub.textContent = `${message} Retrying automatically…`;
  } else {
    elements.distanceSub.textContent =
      `${message} Showing the last known position while we retry.`;
  }
  renderGeoFreshness();
  publishLocationState();
}

function handleGeoSample(sample) {
  if (!sample) return;
  if (sample.error) {
    applyGeoFailure({ message: sample.error, code: sample.code });
    return;
  }
  applyGeoFix({
    latitude: sample.latitude,
    longitude: sample.longitude,
    accuracy: sample.accuracy,
    timestamp: sample.timestamp || Date.now()
  });
}

function startLocationWatch({ force = false, silent = false } = {}) {
  if (!AppState.currentEmployee || !AppState.workplace) return;

  if (document.hidden) {
    stopLocationWatch("paused");
    return;
  }
  if (AppState.shiftStatus === "CLOCKED_OUT") {
    stopLocationWatch("complete");
    return;
  }
  if (geoWatchId !== null) {
    if (!force) return;
    clearLocationWatch();
  }

  if (elements.btnRefreshLocation) elements.btnRefreshLocation.disabled = false;
  if (!silent) showGeoLocating();

  const seq = ++geoRequestSeq;
  const watchId = GeoService.watchDistanceToOffice(
    AppState.workplace.latitude,
    AppState.workplace.longitude,
    AppState.workplace.radius_meters,
    (sample) => {
      if (seq !== geoRequestSeq) return;
      handleGeoSample(sample);
    },
    {
      minIntervalMs: GEO_EMIT_INTERVAL_MS,
      minMovementMeters: GEO_MOVE_THRESHOLD_M,
      maxAccuracy: AppState.workplace.max_allowed_accuracy_meters
    }
  );

  if (geoState === "denied") {
    if (watchId !== null) GeoService.clearWatch(watchId);
    return;
  }

  geoWatchId = watchId;
  if (watchId !== null) {
    startGeoFreshnessTicker();
  } else if (seq === geoRequestSeq) {
    applyGeoFailure("Geolocation is not supported by this browser or device.");
  }
}

function stopLocationWatch(nextState = "idle") {
  clearLocationWatch();
  geoLifecycleGeneration += 1;
  geoRefreshGeneration += 1;
  geoRefreshInFlight = false;
  if (elements.btnRefreshLocation) {
    elements.btnRefreshLocation.disabled = nextState === "complete" || nextState === "signedOut";
    elements.btnRefreshLocation.classList.remove("is-spinning");
  }
  resetRadarPosition();
  geoState = nextState;

  if (nextState === "signedOut") {
    geoLastFixAt = 0;
    geoError = null;
    AppState.currentLocation = null;
    setGeoBadge("GPS Idle", "pill-checking");
    setGeoPulse("");
    if (elements.radarWrapEl) elements.radarWrapEl.className = "radar-wrap";
    elements.distanceValue.textContent = "—";
    elements.distanceSub.textContent = "Sign in to verify your location.";
  } else if (nextState === "paused") {
    setGeoBadge("Tracking Paused", "pill-stale");
    setGeoPulse("");
  } else if (nextState === "complete") {
    setGeoBadge("Shift Complete", "pill-checking");
    setGeoPulse("");
    if (AppState.workplace) {
      elements.distanceSub.textContent =
        `${AppState.workplace.name} · live location tracking stopped after clock-out`;
    }
  }
  renderGeoFreshness();
  publishLocationState();
}

async function refreshLocation({ quiet = false } = {}) {
  if (!AppState.currentEmployee || !AppState.workplace || document.hidden || geoRefreshInFlight) return;

  if (AppState.shiftStatus === "CLOCKED_OUT") {
    stopLocationWatch("complete");
    return;
  }

  geoRefreshInFlight = true;
  const refreshGeneration = ++geoRefreshGeneration;
  const button = elements.btnRefreshLocation;
  if (button) {
    button.disabled = true;
    button.classList.add("is-spinning");
  }

  clearLocationWatch();
  const seq = ++geoRequestSeq;
  showGeoLocating(quiet ? "Checking GPS…" : "Refreshing GPS…");

  try {
    const loc = await GeoService.getCurrentPosition();
    if (seq !== geoRequestSeq) return;
    applyGeoFix(loc);
    if (geoWatchId === null && !document.hidden && AppState.shiftStatus !== "CLOCKED_OUT") {
      startLocationWatch({ silent: true });
    }
  } catch (err) {
    if (seq !== geoRequestSeq) return;
    applyGeoFailure(err);
    // A timeout or transient error should not leave the radar dead: resume
    // watching unless permission was denied or the shift is over.
    if (geoState !== "denied" && !document.hidden && AppState.shiftStatus !== "CLOCKED_OUT") {
      startLocationWatch({ silent: true });
    }
  } finally {
    if (refreshGeneration !== geoRefreshGeneration) return;
    geoRefreshInFlight = false;
    if (button) {
      button.disabled = false;
      button.classList.remove("is-spinning");
    }
  }
}

async function getFreshClockLocation() {
  const employee = AppState.currentEmployee;
  const generation = geoLifecycleGeneration;
  let loc;
  try {
    loc = await GeoService.getCurrentPosition();
  } catch (error) {
    if (generation !== geoLifecycleGeneration || employee !== AppState.currentEmployee) {
      throw Object.assign(new Error("Location request cancelled."), { cancelled: true });
    }
    throw error;
  }
  if (generation !== geoLifecycleGeneration || employee !== AppState.currentEmployee || document.hidden) {
    throw Object.assign(new Error("Location request cancelled."), { cancelled: true });
  }
  applyGeoFix(loc);

  if (geoWatchId === null && !document.hidden && AppState.shiftStatus !== "CLOCKED_OUT") {
    startLocationWatch({ silent: true });
  }
  return loc;
}

function handleVisibilityChange() {
  if (document.hidden) {
    if (AppState.currentEmployee) stopLocationWatch("paused");
    return;
  }
  if (!AppState.currentEmployee) return;
  if (AppState.shiftStatus === "CLOCKED_OUT") {
    stopLocationWatch("complete");
    return;
  }
  refreshLocation({ quiet: true });
}

function handleWindowFocus() {
  if (!AppState.currentEmployee || document.hidden) return;
  if (geoState === "denied") return;
  if (Date.now() - geoLastFixAt >= GEO_EMIT_INTERVAL_MS) {
    refreshLocation({ quiet: true });
  } else if (geoWatchId === null) {
    startLocationWatch({ silent: true });
  }
}

// Distance Radar Update
function updateDistanceRadar(lat, lon, accuracy) {
  if (!AppState.workplace) return;

  const radius = AppState.workplace.radius_meters;
  const { distance: dist, effectiveDistance, isInside, reason } = GeoService.verifyGeofence(
    lat, lon, AppState.workplace.latitude, AppState.workplace.longitude,
    radius, accuracy, AppState.workplace.max_allowed_accuracy_meters
  );
  const validAccuracy = reason === "INSIDE" || reason === "OUTSIDE_GEOFENCE";
  const conclusion = validAccuracy ? (isInside ? "inside" : "outside") : "unable to verify presence within";
  elements.distanceValue.textContent = `You are ${dist} m from the office — ${conclusion} the ${radius} m boundary`;
  elements.distanceSub.textContent = `${AppState.workplace.name} · Radius ${radius}m · ` +
    (typeof accuracy === "number" && Number.isFinite(accuracy) ? `GPS accuracy ±${accuracy} m` : "GPS accuracy unknown") +
    (effectiveDistance === null ? "" : ` · Effective (worst-case) distance ${effectiveDistance} m`);

  if (!validAccuracy) {
    setGeoBadge("Unable to verify — GPS accuracy", "pill-stale");
    setGeoPulse("outside");
    if (elements.radarWrapEl) elements.radarWrapEl.className = 'radar-wrap';
    if (elements.radarDot) elements.radarDot.className = 'radar-user';
    return;
  }

  if (isInside) {
    setGeoBadge("Inside Workplace", "pill-inside");
    setGeoPulse("inside");
    if (elements.radarWrapEl) elements.radarWrapEl.className = 'radar-wrap is-inside';
    if (elements.radarDot)    elements.radarDot.className    = 'radar-user dot-inside';
  } else {
    setGeoBadge("Outside Perimeter", "pill-outside");
    setGeoPulse("outside");
    if (elements.radarWrapEl) elements.radarWrapEl.className = 'radar-wrap is-outside';
    if (elements.radarDot)    elements.radarDot.className    = 'radar-user dot-outside';
  }
}

// Handle Clock In
async function handleClockIn() {
  if (!AppState.currentEmployee) return;
  const employee = AppState.currentEmployee;
  const empId = employee.id;
  const today = getLocalDateString();
  const lock = getShiftLock(empId, today);

  if (AppState.shiftStatus === "CLOCKED_OUT" || (lock && lock.status === "CLOCKED_OUT")) {
    showToast("Shift already completed for today. You cannot clock in again.", "warning");
    AppState.shiftStatus = "CLOCKED_OUT";
    updateActionControls();
    stopLocationWatch("complete");
    return;
  }

  if (AppState.shiftStatus === "CLOCKED_IN" || (lock && lock.status === "CLOCKED_IN")) {
    showToast("You are already clocked in for today.", "warning");
    AppState.shiftStatus = "CLOCKED_IN";
    updateActionControls();
    return;
  }

  elements.btnAction.disabled = true;
  elements.actionBtnText.textContent = "Verifying GPS Location...";

  // Always take a fresh fix immediately before the clock event; the live
  // watcher can be up to 30s old because of throttling.
  let loc;
  try {
    loc = await getFreshClockLocation();
  } catch (err) {
    if (err.cancelled) return;
    applyGeoFailure(err);
    showToast(err.message, "error");
    updateActionControls();
    return;
  }

  try {
    elements.actionBtnText.textContent = "Clocking In...";
    const res = await ApiClient.clockIn(
      loc.latitude,
      loc.longitude,
      loc.accuracy
    );

    if (employee !== AppState.currentEmployee) return;
    saveShiftLock(empId, "CLOCKED_IN", res.record, today);
    AppState.shiftStatus = "CLOCKED_IN";
    AppState.todayRecord = res.record;
    updateActionControls();
    updateTodaySummary();

    showToast(`Arrival verified! Clocked in at ${res.record.clock_in_time}`, "success");
    await refreshShiftData();
  } catch (err) {
    showToast(err.message, "error");
    updateActionControls();
  }
}

// Handle Clock Out
async function handleClockOut() {
  if (!AppState.currentEmployee) return;
  const employee = AppState.currentEmployee;
  const empId = employee.id;
  const today = getLocalDateString();
  const lock = getShiftLock(empId, today);

  if (AppState.shiftStatus === "CLOCKED_OUT" || (lock && lock.status === "CLOCKED_OUT")) {
    showToast("Shift already completed for today.", "info");
    stopLocationWatch("complete");
    AppState.shiftStatus = "CLOCKED_OUT";
    updateActionControls();
    return;
  }

  elements.btnAction.disabled = true;
  elements.actionBtnText.textContent = "Verifying Location...";

  let loc;
  try {
    loc = await getFreshClockLocation();
  } catch (err) {
    if (err.cancelled) return;
    applyGeoFailure(err);
    showToast(err.message, "error");
    updateActionControls();
    return;
  }

  try {
    elements.actionBtnText.textContent = "Clocking Out...";
    const res = await ApiClient.clockOut(
      loc.latitude,
      loc.longitude,
      loc.accuracy
    );

    if (employee !== AppState.currentEmployee) return;
    saveShiftLock(empId, "CLOCKED_OUT", res.record, today);
    AppState.shiftStatus = "CLOCKED_OUT";
    AppState.todayRecord = res.record;
    updateActionControls();
    updateTodaySummary();
    stopLocationWatch("complete");

    showToast(`Departure recorded at ${res.record.clock_out_time}. Shift completed!`, "success");
    await refreshShiftData();
  } catch (err) {
    showToast(err.message, "error");
    updateActionControls();
  }
}

// Event Listeners & Auth Handlers
function setupEventListeners() {
  // 0. Live radar: manual refresh and watcher lifecycle.
  if (elements.btnRefreshLocation) {
    elements.btnRefreshLocation.addEventListener('click', () => refreshLocation());
  }
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', handleWindowFocus);
  window.addEventListener('pagehide', () => stopLocationWatch("paused"));
  window.addEventListener('pageshow', handleVisibilityChange);

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
      showToast('You have securely signed out of your portal.', 'info');
    });
  }
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
