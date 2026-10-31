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

// DOM Elements
const elements = {
  digitalClock: document.getElementById("digitalClock"),
  dateDisplay: document.getElementById("dateDisplay"),
  employeeName: document.getElementById("employeeName"),
  employeeDept: document.getElementById("employeeDept"),
  employeeAvatar: document.getElementById("employeeAvatar"),
  btnSwitchEmployee: document.getElementById("btnSwitchEmployee"),
  modalSwitch: document.getElementById("modalSwitch"),
  modalClose: document.getElementById("modalClose"),
  employeeSelectList: document.getElementById("employeeSelectList"),
  signinForm: document.getElementById("signinForm"),
  signinEmployeeId: document.getElementById("signinEmployeeId"),
  signinPin: document.getElementById("signinPin"),
  signinError: document.getElementById("signinError"),
  btnSignin: document.getElementById("btnSignin"),
  
  // Radar / Status
  statusPulse: document.getElementById("statusPulse"),
  statusBadge: document.getElementById("statusBadge"),
  distanceValue: document.getElementById("distanceValue"),
  distanceSub: document.getElementById("distanceSub"),
  
  // Action Button
  btnAction: document.getElementById("btnAction"),
  actionBtnText: document.getElementById("actionBtnText"),
  
  // Today Summary
  todayClockIn: document.getElementById("todayClockIn"),
  todayClockOut: document.getElementById("todayClockOut"),
  
  // History
  historyList: document.getElementById("historyList"),
  toastContainer: document.getElementById("toastContainer")
};

// Initialize Application
async function init() {
  startClock();
  setupEventListeners();

  try {
    // 1. Fetch Geofence Settings
    AppState.workplace = await ApiClient.getGeofence();
    
    // 2. Fetch Employees List
    AppState.employeesList = await ApiClient.getEmployees();
    
    // 3. Restore Session or Require Staff Sign-In
    const storedId = localStorage.getItem("clockify_active_emp_id");
    if (storedId) {
      AppState.currentEmployee = AppState.employeesList.find(e => e.id === parseInt(storedId));
    }

    if (AppState.currentEmployee) {
      renderEmployeeProfile();
    } else {
      elements.employeeName.textContent = "Not Signed In";
      elements.employeeDept.textContent = "Sign in with your Employee ID and PIN to begin";
      elements.employeeAvatar.textContent = "--";
      elements.actionBtnText.textContent = "Sign In to Clock In";
      elements.btnAction.disabled = true;
      openSwitchModal();
    }

    renderEmployeeModalList();
    
    // 4. Fetch Shift Status & History
    await refreshShiftData();

    // 5. Query Initial Location & Watch Proximity
    queryLiveLocation();
  } catch (err) {
    showToast(err.message, "error");
  }
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

// Refresh Shift Status & History
async function refreshShiftData() {
  if (!AppState.currentEmployee) return;

  try {
    const statusData = await ApiClient.getStatus(AppState.currentEmployee.id);
    AppState.shiftStatus = statusData.status;
    AppState.todayRecord = statusData.record;

    updateActionControls();
    updateTodaySummary();

    const historyData = await ApiClient.getHistory(AppState.currentEmployee.id);
    renderHistory(historyData);
  } catch (err) {
    console.error("Failed to refresh shift:", err);
  }
}

// Update Action Button State
function updateActionControls() {
  elements.btnAction.disabled = false;
  elements.btnAction.classList.remove("btn-clock-out");

  if (AppState.shiftStatus === "NOT_CLOCKED_IN") {
    elements.actionBtnText.textContent = "Clock In Now";
    elements.btnAction.onclick = handleClockIn;
  } else if (AppState.shiftStatus === "CLOCKED_IN") {
    elements.actionBtnText.textContent = "Clock Out";
    elements.btnAction.classList.add("btn-clock-out");
    elements.btnAction.onclick = handleClockOut;
  } else if (AppState.shiftStatus === "CLOCKED_OUT") {
    elements.actionBtnText.textContent = "Shift Completed Today";
    elements.btnAction.disabled = true;
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
  if (!records || records.length === 0) {
    elements.historyList.innerHTML = `<div style="text-align:center; color: var(--text-dim); padding: 1rem;">No recent attendance records.</div>`;
    return;
  }

  elements.historyList.innerHTML = records.map(r => `
    <div class="history-item">
      <div class="history-item-left">
        <span class="history-date">${r.date}</span>
        <span style="font-size: 0.75rem; color: var(--text-muted);">
          In: ${r.clock_in_time || 'N/A'} • Out: ${r.clock_out_time || 'In Progress'}
        </span>
      </div>
      <div>
        <span class="history-status-tag ${r.is_late ? 'tag-late' : 'tag-ontime'}">
          ${r.is_late ? 'Late' : 'On Time'}
        </span>
      </div>
    </div>
  `).join("");
}

// Query Live Location & Update Radar
async function queryLiveLocation() {
  elements.statusBadge.className = "status-badge badge-checking";
  elements.statusBadge.textContent = "Locating...";
  elements.statusPulse.className = "pulse-indicator";

  try {
    const pos = await GeoService.getCurrentPosition();
    AppState.currentLocation = pos;
    updateDistanceRadar(pos.latitude, pos.longitude, pos.accuracy);
  } catch (err) {
    elements.statusBadge.className = "status-badge badge-outside";
    elements.statusBadge.textContent = "GPS Offline";
    elements.distanceValue.textContent = "GPS Error";
    elements.distanceSub.textContent = err.message;
  }
}

// Distance Radar Update
function updateDistanceRadar(lat, lon, accuracy) {
  if (!AppState.workplace) return;

  const dist = GeoService.calculateDistance(
    lat, lon, 
    AppState.workplace.latitude, 
    AppState.workplace.longitude
  );

  const radius = AppState.workplace.radius_meters;
  const isInside = dist <= radius;

  elements.distanceValue.textContent = `${dist}m away`;
  elements.distanceSub.textContent = `Target: ${AppState.workplace.name} (Within ${radius}m required, Accuracy: ±${accuracy}m)`;

  if (isInside) {
    elements.statusBadge.className = "status-badge badge-inside";
    elements.statusBadge.textContent = "Inside Workplace";
    elements.statusPulse.className = "pulse-indicator inside";
  } else {
    elements.statusBadge.className = "status-badge badge-outside";
    elements.statusBadge.textContent = "Outside Perimeter";
    elements.statusPulse.className = "pulse-indicator outside";
  }
}

// Handle Clock In
async function handleClockIn() {
  elements.btnAction.disabled = true;
  elements.actionBtnText.textContent = "Verifying GPS Location...";

  try {
    const loc = await GeoService.getCurrentPosition();
    AppState.currentLocation = loc;
    updateDistanceRadar(loc.latitude, loc.longitude, loc.accuracy);

    elements.actionBtnText.textContent = "Clocking In...";
    const res = await ApiClient.clockIn(
      AppState.currentEmployee.id,
      loc.latitude,
      loc.longitude,
      loc.accuracy
    );

    showToast(`Arrival verified! Clocked in at ${res.record.clock_in_time}`, "success");
    await refreshShiftData();
  } catch (err) {
    showToast(err.message, "error");
    updateActionControls();
  }
}

// Handle Clock Out
async function handleClockOut() {
  elements.btnAction.disabled = true;
  elements.actionBtnText.textContent = "Verifying Location...";

  try {
    const loc = await GeoService.getCurrentPosition();
    AppState.currentLocation = loc;

    elements.actionBtnText.textContent = "Clocking Out...";
    const res = await ApiClient.clockOut(
      AppState.currentEmployee.id,
      loc.latitude,
      loc.longitude,
      loc.accuracy
    );

    showToast(`Departure recorded at ${res.record.clock_out_time}. Shift completed!`, "success");
    await refreshShiftData();
  } catch (err) {
    showToast(err.message, "error");
    updateActionControls();
  }
}

// Event Listeners & Modals
function setupEventListeners() {
  elements.btnSwitchEmployee.addEventListener("click", openSwitchModal);

  elements.signinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    handleSignIn();
  });

  elements.modalClose.addEventListener("click", () => {
    elements.modalSwitch.classList.remove("open");
  });

  elements.modalSwitch.addEventListener("click", (e) => {
    if (e.target === elements.modalSwitch) {
      elements.modalSwitch.classList.remove("open");
    }
  });
}

// Staff Sign-In
function openSwitchModal() {
  elements.signinError.classList.add("hidden");
  elements.modalSwitch.classList.add("open");
  setTimeout(() => elements.signinEmployeeId.focus(), 80);
}

function showSigninError(message) {
  elements.signinError.textContent = message;
  elements.signinError.classList.remove("hidden");
}

async function handleSignIn() {
  const employeeId = parseInt(elements.signinEmployeeId.value, 10);
  const pin = elements.signinPin.value.trim();

  if (!employeeId || !pin) {
    showSigninError("Enter your Employee ID and Security PIN.");
    return;
  }

  elements.btnSignin.disabled = true;
  elements.btnSignin.textContent = "Verifying…";
  elements.signinError.classList.add("hidden");

  try {
    const res = await ApiClient.verifyPin(employeeId, pin);
    AppState.currentEmployee = res.employee;
    localStorage.setItem("clockify_active_emp_id", res.employee.id);

    elements.signinEmployeeId.value = "";
    elements.signinPin.value = "";
    elements.modalSwitch.classList.remove("open");

    renderEmployeeProfile();
    await refreshShiftData();
    showToast(`Signed in as ${res.employee.name}. Welcome!`, "success");
  } catch (err) {
    showSigninError(err.message || "Invalid Employee ID or Security PIN.");
    elements.signinPin.value = "";
    elements.signinPin.focus();
  } finally {
    elements.btnSignin.disabled = false;
    elements.btnSignin.textContent = "Sign In";
  }
}

function renderEmployeeModalList() {
  elements.employeeSelectList.innerHTML = AppState.employeesList.map(emp => `
    <div class="employee-option-card" data-id="${emp.id}">
      <div>
        <strong>${emp.name}</strong>
        <div style="font-size:0.75rem; color:var(--text-muted);">${emp.department} (${emp.staff_id})</div>
      </div>
      <span class="option-id">ID ${emp.id}</span>
    </div>
  `).join("");

  elements.employeeSelectList.querySelectorAll(".employee-option-card").forEach(card => {
    card.addEventListener("click", () => {
      const id = parseInt(card.getAttribute("data-id"));
      elements.signinEmployeeId.value = id;
      elements.signinPin.value = "";
      elements.signinError.classList.add("hidden");
      elements.signinPin.focus();
    });
  });
}

// Toast Notifications
function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;

  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    toast.style.transition = "all 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Run on page load
document.addEventListener("DOMContentLoaded", init);
