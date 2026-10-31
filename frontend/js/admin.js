/**
 * Clockify — Admin Dashboard Controller (admin.js)
 * Exclusive Admin Authentication Gate, Live All-Staff Roster Monitoring,
 * Zero-Flicker Multi-Device Real-Time Attendance Synchronization & Authenticated CSV Export
 */

// Storage Keys
const STORAGE_KEY_GEOFENCE = "clockify_permanent_geofence";
const STORAGE_KEY_ADMIN_TOKEN = "clockify_admin_token";
const STORAGE_KEY_ADMIN_USER = "clockify_admin_user";
const STORAGE_KEY_VIEW_MODE = "clockify_admin_view_mode";

// DOM Elements
const adminElements = {
  // Auth Gate
  adminLoginGate: document.getElementById("adminLoginGate"),
  adminDashboardContent: document.getElementById("adminDashboardContent"),
  adminLoginForm: document.getElementById("adminLoginForm"),
  adminUsername: document.getElementById("adminUsername"),
  adminPin: document.getElementById("adminPin"),
  adminLoginError: document.getElementById("adminLoginError"),
  btnAdminLoginSubmit: document.getElementById("btnAdminLoginSubmit"),
  adminUserBadge: document.getElementById("adminUserBadge"),
  adminUsernameDisplay: document.getElementById("adminUsernameDisplay"),
  btnAdminLogout: document.getElementById("btnAdminLogout"),

  // Header Actions
  adminDateDisplay: document.getElementById("adminDateDisplay"),
  btnRefreshData: document.getElementById("btnRefreshData"),
  liveSyncPill: document.getElementById("liveSyncPill"),
  btnSeedDemo: document.getElementById("btnSeedDemo"),

  // KPIs
  kpiTotalStaff: document.getElementById("kpiTotalStaff"),
  kpiPresent: document.getElementById("kpiPresent"),
  kpiClockedInNow: document.getElementById("kpiClockedInNow"),
  kpiLate: document.getElementById("kpiLate"),
  kpiAbsent: document.getElementById("kpiAbsent"),

  // Geofence Form
  workplaceName: document.getElementById("workplaceName"),
  workplaceLat: document.getElementById("workplaceLat"),
  workplaceLon: document.getElementById("workplaceLon"),
  workplaceRadius: document.getElementById("workplaceRadius"),
  workStartTime: document.getElementById("workStartTime"),
  btnSaveGeofence: document.getElementById("btnSaveGeofence"),
  btnUseCurrentGps: document.getElementById("btnUseCurrentGps"),
  geofenceSaveText: document.getElementById("geofenceSaveText"),

  // Table & Filters
  filterDate: document.getElementById("filterDate"),
  searchEmployee: document.getElementById("searchEmployee"),
  btnToggleAllDates: document.getElementById("btnToggleAllDates"),
  lblToggleAllDates: document.getElementById("lblToggleAllDates"),
  btnApplyFilters: document.getElementById("btnApplyFilters"),
  btnExportCsv: document.getElementById("btnExportCsv"),
  attendanceTableBody: document.getElementById("attendanceTableBody"),

  toastContainer: document.getElementById("toastContainer")
};

// State Variables
let allRecords = [];
let lastRenderedJson = "";
let currentViewMode = localStorage.getItem(STORAGE_KEY_VIEW_MODE) || "roster"; // 'roster' (Today's all-staff live status) or 'history' (session log)
let selectedFilterDate = "";
let autoRefreshTimer = null;
const AUTO_REFRESH_INTERVAL_MS = 5000;

function getLocalDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getStoredAdminToken() {
  const raw = localStorage.getItem(STORAGE_KEY_ADMIN_TOKEN) || sessionStorage.getItem(STORAGE_KEY_ADMIN_TOKEN);
  return raw ? raw.replace(/^["']|["']$/g, '').trim() : null;
}

function getStoredAdminUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ADMIN_USER) || sessionStorage.getItem(STORAGE_KEY_ADMIN_USER);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// Initialize Admin Portal
async function initAdmin() {
  setupAdminListeners();

  const today = getLocalDateString();
  selectedFilterDate = today;
  if (adminElements.filterDate) {
    adminElements.filterDate.value = today;
  }

  updateToggleViewButtonUI();

  if (adminElements.adminDateDisplay) {
    adminElements.adminDateDisplay.textContent = new Date().toLocaleDateString([], {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
    });
  }

  const token = getStoredAdminToken();
  if (!token) {
    showAdminLoginGate();
    return;
  }

  // Token exists, attempt to load dashboard data
  try {
    showAdminDashboardUI();
    await refreshAllDashboardData();
    startLivePolling();
  } catch (err) {
    console.warn("Stored admin token invalid or expired:", err);
    handleAdminLogout();
    showAdminLoginGate("Session expired. Please sign in again.");
  }
}

function updateToggleViewButtonUI() {
  if (!adminElements.lblToggleAllDates || !adminElements.btnToggleAllDates) return;
  if (currentViewMode === "roster") {
    adminElements.lblToggleAllDates.textContent = "📜 View All History";
    adminElements.btnToggleAllDates.classList.add("btn-primary");
    adminElements.btnToggleAllDates.classList.remove("btn-ghost");
  } else {
    adminElements.lblToggleAllDates.textContent = "📅 Today's Live Roster";
    adminElements.btnToggleAllDates.classList.remove("btn-primary");
    adminElements.btnToggleAllDates.classList.add("btn-ghost");
  }
}

function showAdminLoginGate(errorMessage = null) {
  stopLivePolling();
  if (adminElements.adminLoginGate) adminElements.adminLoginGate.style.display = "flex";
  if (adminElements.adminDashboardContent) adminElements.adminDashboardContent.style.display = "none";
  if (adminElements.adminUserBadge) adminElements.adminUserBadge.style.display = "none";
  if (adminElements.btnAdminLogout) adminElements.btnAdminLogout.style.display = "none";

  if (errorMessage && adminElements.adminLoginError) {
    adminElements.adminLoginError.textContent = errorMessage;
    adminElements.adminLoginError.style.display = "block";
  } else if (adminElements.adminLoginError) {
    adminElements.adminLoginError.style.display = "none";
  }

  if (adminElements.adminUsername) adminElements.adminUsername.focus();
}

function showAdminDashboardUI() {
  if (adminElements.adminLoginGate) adminElements.adminLoginGate.style.display = "none";
  if (adminElements.adminDashboardContent) adminElements.adminDashboardContent.style.display = "flex";
  if (adminElements.btnAdminLogout) adminElements.btnAdminLogout.style.display = "inline-flex";

  const adminUser = getStoredAdminUser();
  const displayName = adminUser?.name || adminUser?.username || "techAlhaji";
  if (adminElements.adminUsernameDisplay) {
    adminElements.adminUsernameDisplay.textContent = `🛡️ Lead Tech: ${displayName}`;
  }
  if (adminElements.adminUserBadge) {
    adminElements.adminUserBadge.style.display = "inline-flex";
  }
}

// Fetch Metrics, Geofence, and Records
async function refreshAllDashboardData(silent = false) {
  try {
    let metricsDate = "today";
    let recordsDate = null;
    let viewParam = "roster";

    if (currentViewMode === "roster") {
      metricsDate = selectedFilterDate || "today";
      recordsDate = selectedFilterDate || "today";
      viewParam = "roster";
    } else if (currentViewMode === "history") {
      metricsDate = "today";
      recordsDate = null;
      viewParam = "history";
    } else if (currentViewMode === "custom_date") {
      metricsDate = selectedFilterDate;
      recordsDate = selectedFilterDate;
      viewParam = "roster";
    }

    await Promise.all([
      loadMetrics(metricsDate),
      loadGeofenceSettings(),
      loadAttendanceRecords(recordsDate, viewParam)
    ]);

    // Visual pulse on live sync pill
    if (adminElements.liveSyncPill) {
      adminElements.liveSyncPill.classList.add("synced");
      setTimeout(() => adminElements.liveSyncPill.classList.remove("synced"), 1000);
    }
  } catch (err) {
    if (!silent) {
      const msg = (err.message || "").toLowerCase();
      if (msg.includes("forbidden") || msg.includes("unauthorized") || msg.includes("access denied") || msg.includes("admin credentials required")) {
        handleAdminLogout();
        showAdminLoginGate("Administrative authentication required. Please sign in with Lead Tech credentials.");
      } else {
        showToast(err.message || "Failed to load dashboard data", "error");
      }
    }
  }
}

// Load KPIs
async function loadMetrics(date) {
  try {
    const data = await ApiClient.getAdminMetrics(date);
    if (adminElements.kpiTotalStaff) adminElements.kpiTotalStaff.textContent = data.total_employees ?? "—";
    if (adminElements.kpiPresent) adminElements.kpiPresent.textContent = data.total_present ?? "0";
    if (adminElements.kpiClockedInNow) adminElements.kpiClockedInNow.textContent = data.clocked_in_now ?? "0";
    if (adminElements.kpiLate) adminElements.kpiLate.textContent = data.late_arrivals ?? "0";
    if (adminElements.kpiAbsent) adminElements.kpiAbsent.textContent = data.absent ?? "0";
  } catch (err) {
    console.error("Failed to load metrics:", err);
    throw err;
  }
}

// Load Geofence Configuration with Permanent Persistence
async function loadGeofenceSettings() {
  let savedLocal = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_GEOFENCE);
    if (raw) savedLocal = JSON.parse(raw);
  } catch (e) {}

  if (savedLocal) {
    if (adminElements.workplaceName) adminElements.workplaceName.value = savedLocal.name || "Workplace Headquarters";
    if (adminElements.workplaceLat) adminElements.workplaceLat.value = savedLocal.latitude;
    if (adminElements.workplaceLon) adminElements.workplaceLon.value = savedLocal.longitude;
    if (adminElements.workplaceRadius) adminElements.workplaceRadius.value = savedLocal.radius_meters || 150;
    if (adminElements.workStartTime) adminElements.workStartTime.value = savedLocal.work_start_time || "09:00";
    if (adminElements.geofenceSaveText) {
      adminElements.geofenceSaveText.textContent = `Permanent perimeter active: ${Number(savedLocal.latitude).toFixed(5)}, ${Number(savedLocal.longitude).toFixed(5)}`;
    }
  }

  try {
    const geo = await ApiClient.getGeofence();
    if (savedLocal) {
      const diff = Math.abs(geo.latitude - savedLocal.latitude) > 0.00005 ||
                   Math.abs(geo.longitude - savedLocal.longitude) > 0.00005 ||
                   parseFloat(geo.radius_meters) !== parseFloat(savedLocal.radius_meters);
      if (diff) {
        await ApiClient.updateGeofence(savedLocal);
      }
    } else {
      localStorage.setItem(STORAGE_KEY_GEOFENCE, JSON.stringify(geo));
      if (adminElements.workplaceName) adminElements.workplaceName.value = geo.name;
      if (adminElements.workplaceLat) adminElements.workplaceLat.value = geo.latitude;
      if (adminElements.workplaceLon) adminElements.workplaceLon.value = geo.longitude;
      if (adminElements.workplaceRadius) adminElements.workplaceRadius.value = geo.radius_meters;
      if (adminElements.workStartTime) adminElements.workStartTime.value = geo.work_start_time || "09:00";
    }
  } catch (err) {
    console.error("Failed to load geofence:", err);
  }
}

// Load Attendance Records with View Parameter
async function loadAttendanceRecords(date, view = "roster") {
  try {
    allRecords = await ApiClient.getAdminRecords(date, null, view);
    const term = adminElements.searchEmployee ? adminElements.searchEmployee.value.trim().toLowerCase() : "";
    if (term) {
      filterAndRenderRecords(term);
    } else {
      renderAttendanceTable(allRecords);
    }
  } catch (err) {
    console.error("Failed to load records:", err);
    throw err;
  }
}

// Zero-Flicker Table Renderer with Complete All-Staff Status
function renderAttendanceTable(records) {
  function initials(name) {
    return (name || '?')
      .split(' ')
      .filter(Boolean)
      .map(n => n[0])
      .join('')
      .substring(0, 2)
      .toUpperCase() || 'ST';
  }

  // Prevent flicker: if data has not changed, do not touch DOM
  const newJson = JSON.stringify(records);
  if (newJson === lastRenderedJson && adminElements.attendanceTableBody.children.length > 0) {
    return;
  }
  lastRenderedJson = newJson;

  if (!records || records.length === 0) {
    const subText = currentViewMode === "history"
      ? "No historical clock-in / clock-out events found in the database."
      : "No staff records found for the selected view.";

    adminElements.attendanceTableBody.innerHTML = `
      <tr><td colspan="7">
        <div class="tbl-empty">
          <div class="tbl-empty-ic">📋</div>
          <div class="tbl-empty-msg">No attendance records found</div>
          <div class="tbl-empty-sub">${subText}</div>
        </div>
      </td></tr>`;
    return;
  }

  adminElements.attendanceTableBody.innerHTML = records.map(r => {
    const name = r.name || r.employee_name || (r.staff_id ? 'Staff ' + r.staff_id : 'Staff #' + r.employee_id);
    const dept = r.department || (r.staff_id ? r.staff_id : '');
    const isClockedOut = r.status === 'CLOCKED_OUT';
    const isClockedIn = r.status === 'CLOCKED_IN';
    const isAbsent = !r.status || r.status === 'NOT_CLOCKED_IN' || r.status === 'ABSENT';

    // Time cell formatting
    const inCell = r.clock_in_time
      ? `<span class="td-time">${r.clock_in_time}</span>`
      : `<span class="td-time td-na">—</span>`;

    const outCell = r.clock_out_time
      ? `<span class="td-time">${r.clock_out_time}</span>`
      : `<span class="td-time td-na">—</span>`;

    const gps = r.clock_in_distance != null
      ? `<div style="font-size:.7rem;color:var(--t3);margin-top:2px;font-family:var(--mono);">GPS ${r.clock_in_distance}m</div>`
      : '';

    // Status chip logic:
    // CLOCKED_OUT -> Present (shift finished)
    // CLOCKED_IN  -> Clocked In (active on-site)
    // NOT_CLOCKED_IN / ABSENT -> Not Clocked In (awaiting check-in)
    let statusChip = "";
    let punctualityChip = "";

    if (isClockedOut) {
      statusChip = `<span class="chip chip-done">✓ Present</span>`;
      punctualityChip = `<span class="chip ${r.is_late ? 'chip-late' : 'chip-ontime'}">${r.is_late ? '⏰ Late' : '✓ On Time'}</span>`;
    } else if (isClockedIn) {
      statusChip = `<span class="chip chip-in">● Clocked In</span>`;
      punctualityChip = `<span class="chip ${r.is_late ? 'chip-late' : 'chip-ontime'}">${r.is_late ? '⏰ Late' : '✓ On Time'}</span>`;
    } else {
      statusChip = `<span class="chip chip-absent">○ Not Clocked In</span>`;
      punctualityChip = `<span class="chip chip-pending">— Pending</span>`;
    }

    const notesText = isAbsent
      ? 'Awaiting shift clock-in'
      : (r.notes || 'GPS Verified');

    return `<tr>
      <td>
        <div class="td-emp">
          <div class="td-av">${initials(name)}</div>
          <div>
            <div class="td-name">${name}</div>
            ${dept ? `<div class="td-dept">${dept}</div>` : ''}
          </div>
        </div>
      </td>
      <td style="white-space:nowrap;color:var(--t2);font-size:.84rem;">${r.date || 'Today'}</td>
      <td>${inCell}${gps}</td>
      <td>${outCell}</td>
      <td>${statusChip}</td>
      <td>${punctualityChip}</td>
      <td style="font-size:.78rem;color:var(--t3);">${notesText}</td>
    </tr>`;
  }).join('');
}

function filterAndRenderRecords(term) {
  if (!term) {
    renderAttendanceTable(allRecords);
    return;
  }
  const filtered = allRecords.filter(r => {
    const name = (r.name || r.employee_name || '').toLowerCase();
    const dept = (r.department || '').toLowerCase();
    const staffId = (r.staff_id || '').toLowerCase();
    const notes = (r.notes || '').toLowerCase();
    return name.includes(term) || dept.includes(term) || staffId.includes(term) || notes.includes(term);
  });
  renderAttendanceTable(filtered);
}

// Live Polling (Multi-device real-time sync)
function startLivePolling() {
  stopLivePolling();
  autoRefreshTimer = setInterval(() => {
    refreshAllDashboardData(true);
  }, AUTO_REFRESH_INTERVAL_MS);
}

function stopLivePolling() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function handleAdminLogout() {
  stopLivePolling();
  localStorage.removeItem(STORAGE_KEY_ADMIN_TOKEN);
  sessionStorage.removeItem(STORAGE_KEY_ADMIN_TOKEN);
  localStorage.removeItem(STORAGE_KEY_ADMIN_USER);
  sessionStorage.removeItem(STORAGE_KEY_ADMIN_USER);
  showAdminLoginGate();
  showToast("Signed out of Admin Console.", "info");
}

// Event Listeners
function setupAdminListeners() {
  // Admin Login Form Submit
  if (adminElements.adminLoginForm) {
    adminElements.adminLoginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = adminElements.adminUsername.value.trim();
      const pin = adminElements.adminPin.value.trim();

      if (!username || !pin) {
        if (adminElements.adminLoginError) {
          adminElements.adminLoginError.textContent = "Please enter both admin username and security PIN.";
          adminElements.adminLoginError.style.display = "block";
        }
        return;
      }

      if (adminElements.btnAdminLoginSubmit) {
        adminElements.btnAdminLoginSubmit.disabled = true;
        adminElements.btnAdminLoginSubmit.innerHTML = `<span>Verifying credentials...</span>`;
      }
      if (adminElements.adminLoginError) adminElements.adminLoginError.style.display = "none";

      try {
        const response = await ApiClient.adminLogin(username, pin);
        const token = response.token;
        const user = response.user;

        localStorage.setItem(STORAGE_KEY_ADMIN_TOKEN, token);
        sessionStorage.setItem(STORAGE_KEY_ADMIN_TOKEN, token);
        localStorage.setItem(STORAGE_KEY_ADMIN_USER, JSON.stringify(user));

        showAdminDashboardUI();
        await refreshAllDashboardData();
        startLivePolling();
        showToast(`Welcome back, ${user.name || "Lead Tech"}! Exclusive console unlocked.`, "success");
      } catch (err) {
        if (adminElements.adminLoginError) {
          adminElements.adminLoginError.textContent = err.message || "Invalid admin credentials or restricted access.";
          adminElements.adminLoginError.style.display = "block";
        }
        showToast(err.message || "Admin authentication failed", "error");
      } finally {
        if (adminElements.btnAdminLoginSubmit) {
          adminElements.btnAdminLoginSubmit.disabled = false;
          adminElements.btnAdminLoginSubmit.innerHTML = `
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            Unlock Admin Console
          `;
        }
      }
    });
  }

  // Admin Logout Button
  if (adminElements.btnAdminLogout) {
    adminElements.btnAdminLogout.addEventListener("click", () => {
      handleAdminLogout();
    });
  }

  // Refresh Button
  if (adminElements.btnRefreshData) {
    adminElements.btnRefreshData.addEventListener("click", async () => {
      adminElements.btnRefreshData.classList.add("loading");
      await refreshAllDashboardData();
      adminElements.btnRefreshData.classList.remove("loading");
      showToast("Attendance records refreshed!", "info");
    });
  }

  // Save Geofence Form
  if (adminElements.btnSaveGeofence) {
    adminElements.btnSaveGeofence.addEventListener("click", async () => {
      try {
        const lat = parseFloat(adminElements.workplaceLat.value);
        const lon = parseFloat(adminElements.workplaceLon.value);
        const radius = parseFloat(adminElements.workplaceRadius.value);
        const name = adminElements.workplaceName.value.trim() || "Workplace Headquarters";
        const startTime = adminElements.workStartTime.value || "09:00";

        if (isNaN(lat) || isNaN(lon) || isNaN(radius)) {
          showToast("Please enter valid latitude, longitude, and radius values.", "error");
          return;
        }

        const payload = {
          name: name,
          latitude: lat,
          longitude: lon,
          radius_meters: radius,
          work_start_time: startTime
        };

        await ApiClient.updateGeofence(payload);
        localStorage.setItem(STORAGE_KEY_GEOFENCE, JSON.stringify(payload));
        if (adminElements.geofenceSaveText) {
          adminElements.geofenceSaveText.textContent = `Permanent perimeter active: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        }
        showToast("Perimeter saved permanently! Preserved across reloads and multi-device clock-ins.", "success");
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  // Use Current GPS as Office Perimeter
  if (adminElements.btnUseCurrentGps) {
    adminElements.btnUseCurrentGps.addEventListener("click", async () => {
      try {
        showToast("Acquiring device GPS coordinates...", "warning");
        const pos = await GeoService.getCurrentPosition();
        adminElements.workplaceLat.value = pos.latitude;
        adminElements.workplaceLon.value = pos.longitude;

        const payload = {
          name: adminElements.workplaceName.value.trim() || "Admin Designated Perimeter",
          latitude: pos.latitude,
          longitude: pos.longitude,
          radius_meters: parseFloat(adminElements.workplaceRadius.value) || 150,
          work_start_time: adminElements.workStartTime.value || "09:00"
        };

        await ApiClient.updateGeofence(payload);
        localStorage.setItem(STORAGE_KEY_GEOFENCE, JSON.stringify(payload));
        if (adminElements.geofenceSaveText) {
          adminElements.geofenceSaveText.textContent = `Permanent perimeter active: ${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)}`;
        }
        showToast(`📍 Set & permanently saved perimeter to your location (±${pos.accuracy}m)!`, "success");
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  // Mobile Hamburger Toggle
  const navHamburger = document.getElementById("navHamburger");
  const navActions = document.getElementById("navActions");
  if (navHamburger && navActions) {
    navHamburger.addEventListener("click", () => {
      const isOpen = navActions.classList.toggle("is-open");
      navHamburger.classList.toggle("is-active", isOpen);
      navHamburger.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });

    document.addEventListener("click", (e) => {
      if (!navHamburger.contains(e.target) && !navActions.contains(e.target)) {
        navActions.classList.remove("is-open");
        navHamburger.classList.remove("is-active");
        navHamburger.setAttribute("aria-expanded", "false");
      }
    });

    navActions.querySelectorAll("a, button").forEach(item => {
      item.addEventListener("click", () => {
        navActions.classList.remove("is-open");
        navHamburger.classList.remove("is-active");
        navHamburger.setAttribute("aria-expanded", "false");
      });
    });
  }

  // Toggle View: Today's Live Roster (All Staff) vs Complete History Log
  if (adminElements.btnToggleAllDates) {
    adminElements.btnToggleAllDates.addEventListener("click", async () => {
      if (currentViewMode === "roster") {
        currentViewMode = "history";
      } else {
        currentViewMode = "roster";
        selectedFilterDate = getLocalDateString();
        if (adminElements.filterDate) adminElements.filterDate.value = selectedFilterDate;
      }
      localStorage.setItem(STORAGE_KEY_VIEW_MODE, currentViewMode);
      updateToggleViewButtonUI();
      lastRenderedJson = ""; // force fresh render
      await refreshAllDashboardData();
    });
  }

  // Apply Date Filter
  if (adminElements.btnApplyFilters) {
    adminElements.btnApplyFilters.addEventListener("click", async () => {
      const chosen = adminElements.filterDate ? adminElements.filterDate.value : "";
      if (chosen) {
        selectedFilterDate = chosen;
        currentViewMode = "custom_date";
        if (adminElements.lblToggleAllDates) adminElements.lblToggleAllDates.textContent = "📅 Today's Live Roster";
        if (adminElements.btnToggleAllDates) {
          adminElements.btnToggleAllDates.classList.remove("btn-primary");
          adminElements.btnToggleAllDates.classList.add("btn-ghost");
        }
      } else {
        currentViewMode = "roster";
        selectedFilterDate = getLocalDateString();
        updateToggleViewButtonUI();
      }
      lastRenderedJson = "";
      await refreshAllDashboardData();
      showToast(`Showing attendance records for ${selectedFilterDate}`, "info");
    });
  }

  // Search Filter by Name, Dept, or Staff ID
  if (adminElements.searchEmployee) {
    adminElements.searchEmployee.addEventListener("input", (e) => {
      filterAndRenderRecords(e.target.value.trim().toLowerCase());
    });
  }

  // Export CSV with attached token for authenticated download
  if (adminElements.btnExportCsv) {
    adminElements.btnExportCsv.addEventListener("click", () => {
      const date = (currentViewMode === "roster" || currentViewMode === "custom_date") ? (selectedFilterDate || "today") : null;
      const token = getStoredAdminToken();
      const params = new URLSearchParams();
      if (token) params.append("token", token);
      if (date) params.append("date", date);
      const url = `${window.location.origin}/api/admin/export/csv?${params.toString()}`;
      window.open(url, "_blank");
    });
  }

  // Seed Demo Data
  if (adminElements.btnSeedDemo) {
    adminElements.btnSeedDemo.addEventListener("click", async () => {
      try {
        await ApiClient.seedDemo();
        showToast("Demo attendance records seeded across all 10 employees for today!", "success");
        currentViewMode = "roster";
        selectedFilterDate = getLocalDateString();
        updateToggleViewButtonUI();
        lastRenderedJson = "";
        await refreshAllDashboardData();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }
}

// Toast Notifications
const ADMIN_ICONS = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
function showToast(message, type = 'info') {
  if (!adminElements.toastContainer) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="t-icon">${ADMIN_ICONS[type] || 'ℹ'}</div><span>${message}</span>`;
  adminElements.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(110%)';
    toast.style.transition = 'all .35s cubic-bezier(.4,0,1,1)';
    setTimeout(() => toast.remove(), 360);
  }, 4500);
}

document.addEventListener("DOMContentLoaded", initAdmin);
