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

  // History
  historyList:   document.getElementById('historyList'),
  historyCount:  document.getElementById('historyCount'),
  toastContainer: document.getElementById('toastContainer')
};

// Initialize Application
async function init() {
  startClock();
  setupEventListeners();
  await initDB();

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

// Detect clock skew between device and server
// Server returns server_time and timezone_offset in getStatus response
let lastSkewWarning = 0;
const SKEW_WARN_COOLDOWN_MS = 60000; // 1 min cooldown

function computeSkewMinutes(serverTimeStr) {
  // Server time is HH:MM:SS in WAT (UTC+1)
  // Device time is whatever getLocalDateString() provides
  const [sh, sm, ss] = serverTimeStr.split(":").map(Number);
  const serverMinutes = sh * 60 + sm;
  const now = new Date();
  const deviceMinutes = now.getHours() * 60 + now.getMinutes();
  return serverMinutes - deviceMinutes; // positive = server ahead
}

function maybeShowSkewWarning(skewMinutes) {
  const now = Date.now();
  if (now - lastSkewWarning < SKEW_WARN_COOLDOWN_MS) return;
  if (Math.abs(skewMinutes) > 2) {
    showToast(`⚠ Clock skew: server time (${skewMinutes > 0 ? 'ahead' : 'behind'}) ${Math.abs(skewMinutes)} min` + (skewMinutes !== 0 ? ' from your device' : ''), "warning");
    lastSkewWarning = now;
  }
}

// Shift lock is keyed by employee_id + server date from /api/attendance/status.
// This ensures the lock survives across device timezones/changes and page refreshes.
// Local storage only stores a cache for instant paint; the server status always wins.
let shiftLockCache = {};

function getShiftLockKey(employeeId, serverDate) {
  return `clockify_shift_lock_${employeeId}_${serverDate}`;
}

function getShiftLock(employeeId, serverDate) {
  // Check local cache first (populated from server on refresh)
  if (shiftLockCache[getShiftLockKey(employeeId, serverDate)]) {
    return shiftLockCache[getShiftLockKey(employeeId, serverDate)];
  }
  // Fall back to localStorage only if no server data available
  try {
    const raw = localStorage.getItem(getShiftLockKey(employeeId, serverDate));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveShiftLock(employeeId, status, record, serverDate) {
  try {
    const payload = {
      employee_id: employeeId,
      status: status,
      date: serverDate,
      record: record,
      locked_at: new Date().toISOString()
    };
    shiftLockCache[getShiftLockKey(employeeId, serverDate)] = payload;
    localStorage.setItem(getShiftLockKey(employeeId, serverDate), JSON.stringify(payload));
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

  try {
    const statusData = await ApiClient.getStatus(empId);

    AppState.shiftStatus = statusData.status;
    AppState.todayRecord = statusData.record;
    AppState.serverTime = statusData.server_time;
    AppState.timezoneOffset = statusData.timezone_offset;

    // Use the server's date from the status response for the shift lock key.
    // This ensures the lock survives across device timezones/changes and refreshes.
    const lockDate = statusData.date || (statusData.server_time ? 
      // Parse server date from server_time (HH:MM:SS in WAT/UTC+1)
      // We use the date portion from the status API response; if only time is provided,
      // we defer to the server's concept of the current day.
      null : null);

    if (statusData.status === "CLOCKED_IN" || statusData.status === "CLOCKED_OUT") {
      // If statusData.date is provided, use it; otherwise compute from server time
      const effectiveLockDate = statusData.date || AppState.todayRecord?.date || 
        // If we have no date from server, we rely on the refresh cycle to provide it
        // and keep lockDate as null (will be re-fetched on next refresh)
        null;
      saveShiftLock(empId, statusData.status, statusData.record, effectiveLockDate);
    }

    // Show clock-skew warning if server time differs from device by more than 2 min
    maybeShowSkewWarning(statusData.server_time || "");

    updateActionControls();
    updateTodaySummary();

    const historyData = await ApiClient.getHistory(empId);
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
    elements.btnAction.onclick = () => handleClockOut();
  } else {
    elements.actionBtnText.textContent = "Clock In Now";
    elements.btnAction.disabled = false;
    elements.btnAction.onclick = () => handleClockIn(clockIntentId);
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
  if (!AppState.workplace) return;

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

// Handle Clock In
// The server is the source of truth for the attendance day.
// We pass the clockIntentId for idempotency — if a record already exists
// for this intent, the server returns it and reconciles instead of erroring.
async function handleClockIn(clockIntentId) {
  if (!AppState.currentEmployee) return;
  const empId = AppState.currentEmployee.id;

  // Use the cached shift status and todayRecord from refreshShiftData,
  // which are keyed by the server date. Do NOT use getLocalDateString().
  const todayRecord = AppState.todayRecord;
  const lock = todayRecord ? getShiftLock(empId, todayRecord.date) : null;

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

  elements.btnAction.disabled = true;
  elements.actionBtnText.textContent = "Verifying GPS Location...";

  try {
    const loc = await GeoService.getCurrentPosition();
    AppState.currentLocation = loc;
    updateDistanceRadar(loc.latitude, loc.longitude, loc.accuracy);

    // Check if we're online before attempting to clock in
    if (!navigator.onLine) {
      // Queue the clock-in event for offline submission
      const event = {
        type: 'clock-in',
        employeeId: empId,
        latitude: loc.latitude,
        longitude: loc.longitude,
        accuracy: loc.accuracy,
        clockIntentId: clockIntentId
      };
      const queuedId = await queueClockEvent(event);
      elements.actionBtnText.textContent = "Clocking In (Pending)...";
      showToast("Clocking in offline — record will be saved when you're back online.", "info");
      // Try to queue and then attempt sync when back online
      await queueClockEvent(event);
      return;
    }

    elements.actionBtnText.textContent = "Clocking In...";
    const res = await ApiClient.clockIn(
      loc.latitude,
      loc.longitude,
      loc.accuracy,
      clockIntentId
    );

    // Server may return the existing record if clockIntentId matches one from a prior offline attempt.
    saveShiftLock(empId, "CLOCKED_IN", res.record, res.record?.date || AppState.todayRecord?.date);
    AppState.shiftStatus = "CLOCKED_IN";
    AppState.todayRecord = res.record;
    updateActionControls();
    updateTodaySummary();

    showToast(`Arrival verified! Clocked in at ${res.record.clock_in_time}`, "success");
    await refreshShiftData();
  } catch (err) {
    const msg = (err.message || "").toLowerCase();
    // If we got a server error (not network), check if it's a duplicate intent
    if (!navigator.onLine || msg.includes('duplicate') || msg.includes('already exists')) {
      // If offline or server says duplicate, queue for retry
      const event = {
        type: 'clock-in',
        employeeId: empId,
        latitude: AppState.currentLocation?.latitude || 0,
        longitude: AppState.currentLocation?.longitude || 0,
        accuracy: AppState.currentLocation?.accuracy || 0,
        clockIntentId: clockIntentId
      };
      await queueClockEvent(event);
      showToast("Clock-in queued for retry when back online.", "warning");
    } else {
      showToast(err.message, "error");
    }
    updateActionControls();
  }
}

// Handle Clock Out
async function handleClockOut() {
  if (!AppState.currentEmployee) return;
  const empId = AppState.currentEmployee.id;

  // Use the cached shift status and todayRecord from refreshShiftData,
  // which are keyed by the server date. Do NOT use getLocalDateString().
  const todayRecord = AppState.todayRecord;
  const lock = todayRecord ? getShiftLock(empId, todayRecord.date) : null;

  if (AppState.shiftStatus === "CLOCKED_OUT" || (lock && lock.status === "CLOCKED_OUT")) {
    showToast("Shift already completed for today.", "info");
    AppState.shiftStatus = "CLOCKED_OUT";
    updateActionControls();
    return;
  }

  elements.btnAction.disabled = true;
  elements.actionBtnText.textContent = "Verifying Location...";

  try {
    const loc = await GeoService.getCurrentPosition();
    AppState.currentLocation = loc;

    // Check if we're online before attempting to clock out
    if (!navigator.onLine) {
      // Queue the clock-out event for offline submission
      const event = {
        type: 'clock-out',
        employeeId: empId,
        latitude: loc.latitude,
        longitude: loc.longitude,
        accuracy: loc.accuracy
      };
      const queuedId = await queueClockEvent(event);
      elements.actionBtnText.textContent = "Clocking Out (Pending)...";
      showToast("Clocking out offline — record will be saved when you're back online.", "info");
      return;
    }

    elements.actionBtnText.textContent = "Clocking Out...";
    const res = await ApiClient.clockOut(
      loc.latitude,
      loc.longitude,
      loc.accuracy
    );

    saveShiftLock(empId, "CLOCKED_OUT", res.record, res.record?.date || AppState.todayRecord?.date);
    AppState.shiftStatus = "CLOCKED_OUT";
    AppState.todayRecord = res.record;
    updateActionControls();
    updateTodaySummary();

    showToast(`Departure recorded at ${res.record.clock_out_time}. Shift completed!`, "success");
    await refreshShiftData();
  } catch (err) {
    const msg = (err.message || "").toLowerCase();
    // If we got a server error, queue for retry
    if (!navigator.onLine || msg.includes('duplicate') || msg.includes('already exists')) {
      const event = {
        type: 'clock-out',
        employeeId: empId,
        latitude: AppState.currentLocation?.latitude || 0,
        longitude: AppState.currentLocation?.longitude || 0,
        accuracy: AppState.currentLocation?.accuracy || 0
      };
      await queueClockEvent(event);
      showToast("Clock-out queued for retry when back online.", "warning");
    } else {
      showToast(err.message, "error");
    }
    updateActionControls();
  }
}

// Event Listeners & Auth Handlers
// A clock intent ID is generated per clock-in attempt to ensure idempotency.
// It is stored in localStorage so that if the user goes offline and comes back online,
// the same intent ID can be reused to avoid creating duplicate records.
let clockIntentId = localStorage.getItem('clockify_clock_intent_id');
if (!clockIntentId) {
  clockIntentId = 'clockify-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
  localStorage.setItem('clockify_clock_intent_id', clockIntentId);
}

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
      // Clear the clock intent ID on logout so a fresh session starts clean
      localStorage.removeItem('clockify_clock_intent_id');
      clockIntentId = localStorage.getItem('clockify_clock_intent_id');
      if (!clockIntentId) {
        clockIntentId = 'clockify-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
        localStorage.setItem('clockify_clock_intent_id', clockIntentId);
      }
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

// Online/offline event listeners for clock event retry
window.addEventListener('online', async () => {
  console.log('Network is back online, retrying queued clock events...');
  const pendingEvents = await getPendingEvents();
  for (const event of pendingEvents) {
    try {
      const url = event.type === 'clock-in'
        ? '/api/attendance/clock-in'
        : '/api/attendance/clock-out';

      const payload = {
        latitude: event.latitude,
        longitude: event.longitude,
        accuracy: event.accuracy,
        clock_intent_id: event.clockIntentId
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        await updateEventStatus(event.id, 'synced');
      } else {
        const errorData = await response.json().catch(() => ({}));
        await updateEventStatus(event.id, 'failed', errorData.detail || 'Request failed');
      }
    } catch (err) {
      await updateEventStatus(event.id, 'failed', err.message);
    }
  }
});

function queueClockEvent(event) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('clock-queue', 'readwrite');
    const store = transaction.objectStore('clock-queue');
    const request = store.add({
      ...event,
      status: 'pending',
      created_at: new Date().toISOString(),
      attempts: 0
    });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getPendingEvents() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('clock-queue', 'readonly');
    const store = transaction.objectStore('clock-queue');
    const request = store.getAll(event => event.status === 'pending');
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function updateEventStatus(id, status, error = null) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('clock-queue', 'readwrite');
    const store = transaction.objectStore('clock-queue');
    const request = store.get(id);
    request.onsuccess = async () => {
      const event = request.result;
      if (event) {
        event.status = status;
        event.error = error;
        event.attempts += 1;
        const updateRequest = store.put(event);
        updateRequest.onsuccess = () => resolve(event);
        updateRequest.onerror = () => reject(updateRequest.error);
      } else {
        reject(new Error('Event not found'));
      }
    };
    request.onerror = () => reject(request.error);
  });
}

function deleteEvent(id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('clock-queue', 'readwrite');
    const store = transaction.objectStore('clock-queue');
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function backoffDelay(attempts) {
  const base = 1000;
  const jitter = Math.random() * 1000;
  const delay = base * Math.pow(2, Math.min(attempts, 5)) + jitter;
  return Math.min(delay, 30000);
}
