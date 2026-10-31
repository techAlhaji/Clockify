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

  try {
    // 1. Fetch Geofence Settings
    AppState.workplace = await ApiClient.getGeofence();
    
    // Check if admin has saved a permanent geofence in localStorage
    const savedGeoStr = localStorage.getItem("clockify_permanent_geofence");
    if (savedGeoStr) {
      try {
        const savedGeo = JSON.parse(savedGeoStr);
        const diff = Math.abs(AppState.workplace.latitude - savedGeo.latitude) > 0.00005 ||
                     Math.abs(AppState.workplace.longitude - savedGeo.longitude) > 0.00005 ||
                     parseFloat(AppState.workplace.radius_meters) !== parseFloat(savedGeo.radius_meters);
        if (diff) {
          await ApiClient.updateGeofence(savedGeo);
          AppState.workplace = savedGeo;
        }
      } catch (e) {}
    }
    
    // 2. Fetch Employees List to populate login selector
    AppState.employeesList = await ApiClient.getEmployees();
    populateEmployeeLoginSelect();

    // 3. Check for Authenticated Employee Session
    const authRaw = localStorage.getItem(STORAGE_AUTH_KEY);
    if (authRaw) {
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
    `<option value="${e.id}" data-staff="${e.staff_id}">${e.name} — ${e.department} (${e.staff_id})</option>`
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

// Refresh Shift Status & History with persistent lock priority
async function refreshShiftData() {
  if (!AppState.currentEmployee) return;
  const empId = AppState.currentEmployee.id;
  const today = getLocalDateString();

  // 1. Immediately apply persistent shift lock from device storage
  const localLock = getShiftLock(empId, today);
  if (localLock) {
    AppState.shiftStatus = localLock.status;
    AppState.todayRecord = localLock.record;
    updateActionControls();
    updateTodaySummary();
  }

  try {
    const statusData = await ApiClient.getStatus(empId);

    // If device lock says CLOCKED_OUT, STRICTLY ENFORCE CLOCKED_OUT (Cannot reset on refresh!)
    if (localLock && localLock.status === "CLOCKED_OUT") {
      AppState.shiftStatus = "CLOCKED_OUT";
      AppState.todayRecord = localLock.record || statusData.record;
      // Auto-sync completed shift to backend if backend was missing it (e.g. serverless cold start)
      if (statusData.status !== "CLOCKED_OUT" && localLock.record) {
        try {
          await ApiClient.syncShift(localLock.record);
        } catch (e) {}
      }
    } else if (statusData.status === "CLOCKED_OUT") {
      AppState.shiftStatus = "CLOCKED_OUT";
      AppState.todayRecord = statusData.record;
      saveShiftLock(empId, "CLOCKED_OUT", statusData.record, today);
    } else if (localLock && localLock.status === "CLOCKED_IN") {
      AppState.shiftStatus = "CLOCKED_IN";
      AppState.todayRecord = localLock.record || statusData.record;
      if (statusData.status === "NOT_CLOCKED_IN" && localLock.record) {
        try {
          await ApiClient.syncShift(localLock.record);
        } catch (e) {}
      }
    } else {
      AppState.shiftStatus = statusData.status;
      AppState.todayRecord = statusData.record;
      if (statusData.status === "CLOCKED_IN") {
        saveShiftLock(empId, "CLOCKED_IN", statusData.record, today);
      }
    }

    updateActionControls();
    updateTodaySummary();

    const historyData = await ApiClient.getHistory(empId);
    renderHistory(historyData);
  } catch (err) {
    console.error("Failed to refresh shift:", err);
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
          <div class="h-date-str">${r.date}</div>
          <div class="h-times">In: ${r.clock_in_time || 'N/A'}&nbsp;·&nbsp;Out: ${r.clock_out_time || 'In Progress'}</div>
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
async function handleClockIn() {
  if (!AppState.currentEmployee) return;
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

  elements.btnAction.disabled = true;
  elements.actionBtnText.textContent = "Verifying GPS Location...";

  try {
    const loc = await GeoService.getCurrentPosition();
    AppState.currentLocation = loc;
    updateDistanceRadar(loc.latitude, loc.longitude, loc.accuracy);

    elements.actionBtnText.textContent = "Clocking In...";
    const res = await ApiClient.clockIn(
      empId,
      loc.latitude,
      loc.longitude,
      loc.accuracy
    );

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
  const empId = AppState.currentEmployee.id;
  const today = getLocalDateString();
  const lock = getShiftLock(empId, today);

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

    elements.actionBtnText.textContent = "Clocking Out...";
    const res = await ApiClient.clockOut(
      empId,
      loc.latitude,
      loc.longitude,
      loc.accuracy
    );

    saveShiftLock(empId, "CLOCKED_OUT", res.record, today);
    AppState.shiftStatus = "CLOCKED_OUT";
    AppState.todayRecord = res.record;
    updateActionControls();
    updateTodaySummary();

    showToast(`Departure recorded at ${res.record.clock_out_time}. Shift completed!`, "success");
    await refreshShiftData();
  } catch (err) {
    showToast(err.message, "error");
    updateActionControls();
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
      if (elements.loginPin) elements.loginPin.value = '';
      showLoginGate();
      showToast('You have securely signed out of your portal.', 'info');
    });
  }
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
    <span>${message}</span>
  `;
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
