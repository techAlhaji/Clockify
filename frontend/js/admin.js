/**
 * Clockify — Admin Dashboard Controller (admin.js)
 * Exclusive Admin Authentication Gate, Live All-Staff Roster Monitoring,
 * Zero-Flicker Multi-Device Real-Time Attendance Synchronization & Authenticated CSV Export
 */

// Storage Keys
const STORAGE_KEY_ADMIN_TOKEN = "clockify_admin_token";
const STORAGE_KEY_ADMIN_USER = "clockify_admin_user";

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
  btnViewRoster: document.getElementById("btnViewRoster"),
  btnViewHistory: document.getElementById("btnViewHistory"),
  btnViewRange: document.getElementById("btnViewRange"),
  filterStartDate: document.getElementById("filterStartDate"),
  filterEndDate: document.getElementById("filterEndDate"),
  dateRangeFields: document.getElementById("dateRangeFields"),
  searchEmployee: document.getElementById("searchEmployee"),
  filterDepartment: document.getElementById("filterDepartment"),
  filterStatus: document.getElementById("filterStatus"),
  filterLateOnly: document.getElementById("filterLateOnly"),
  btnApplyFilters: document.getElementById("btnApplyFilters"),
  btnExportCsv: document.getElementById("btnExportCsv"),
  activeFilterBar: document.getElementById("activeFilterBar"),
  activeFilterChips: document.getElementById("activeFilterChips"),
  btnClearFilters: document.getElementById("btnClearFilters"),
  recordCount: document.getElementById("recordCount"),
  tablePagination: document.getElementById("tablePagination"),
  paginationSummary: document.getElementById("paginationSummary"),
  pageSizeSelect: document.getElementById("pageSizeSelect"),
  btnPrevPage: document.getElementById("btnPrevPage"),
  btnNextPage: document.getElementById("btnNextPage"),
  pageIndicator: document.getElementById("pageIndicator"),
  attendanceTableBody: document.getElementById("attendanceTableBody"),

  toastContainer: document.getElementById("toastContainer")
};

// Unified view + filter state. The mode owns the date range so the date
// controls and the view switch can never describe two different queries.
const viewState = {
  mode: "roster", // 'roster' | 'history' | 'range'
  startDate: "",
  endDate: "",
  search: "",
  department: "",
  status: "",
  lateOnly: false,
  page: 1,
  pageSize: 25
};
let allRecords = [];
let lastRenderedJson = "";
let recordsTotal = 0;
let recordsTotalPages = 0;
let autoRefreshTimer = null;
let searchDebounceTimer = null;
let recordsRequestSeq = 0;
let departmentsLoaded = false;
const AUTO_REFRESH_INTERVAL_MS = 5000;
const SEARCH_DEBOUNCE_MS = 300;
const STATUS_LABELS = {
  CLOCKED_IN: "Clocked In",
  CLOCKED_OUT: "Clocked Out",
  NOT_CLOCKED_IN: "Not Clocked In / Absent",
  ABSENT: "Absent"
};

function getLocalDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The admin session lives in sessionStorage only, so it disappears when the tab closes
// and is never left behind on a shared machine.
function getStoredAdminToken() {
  const raw = sessionStorage.getItem(STORAGE_KEY_ADMIN_TOKEN);
  return raw ? raw.replace(/^["']|["']$/g, '').trim() : null;
}

function getStoredAdminUser() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY_ADMIN_USER);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// Escape untrusted values before they reach innerHTML.
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// Initialize Admin Portal
async function initAdmin() {
  setupAdminListeners();

  const today = getLocalDateString();
  viewState.startDate = today;
  viewState.endDate = today;
  updateViewUI();
  updateFilterChips();

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
    await loadDepartmentOptions();
    startLivePolling();
  } catch (err) {
    console.warn("Stored admin token invalid or expired:", err);
    handleAdminLogout();
    showAdminLoginGate("Session expired. Please sign in again.");
  }
}

function updateViewUI() {
  const buttons = [
    ["roster", adminElements.btnViewRoster],
    ["history", adminElements.btnViewHistory],
    ["range", adminElements.btnViewRange]
  ];
  buttons.forEach(([mode, button]) => {
    if (!button) return;
    const active = viewState.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });

  const rangeActive = viewState.mode === "range";
  const today = getLocalDateString();
  const startValue = rangeActive ? viewState.startDate : (viewState.mode === "roster" ? today : "");
  const endValue = rangeActive ? viewState.endDate : (viewState.mode === "roster" ? today : "");

  if (adminElements.filterStartDate) {
    adminElements.filterStartDate.value = startValue;
    adminElements.filterStartDate.disabled = !rangeActive;
    adminElements.filterStartDate.max = viewState.endDate || "";
  }
  if (adminElements.filterEndDate) {
    adminElements.filterEndDate.value = endValue;
    adminElements.filterEndDate.disabled = !rangeActive;
    adminElements.filterEndDate.min = viewState.startDate || "";
  }
  if (adminElements.dateRangeFields) {
    adminElements.dateRangeFields.classList.toggle("is-disabled", !rangeActive);
  }
}

function setViewMode(mode) {
  if (!["roster", "history", "range"].includes(mode)) return;
  viewState.mode = mode;
  viewState.page = 1;
  if (mode !== "range") {
    const today = getLocalDateString();
    viewState.startDate = today;
    viewState.endDate = today;
  }
  updateViewUI();
  updateFilterChips();
  lastRenderedJson = "";
  void refreshAllDashboardData();
}

function getActiveFilterLabels() {
  const filters = [];
  if (viewState.search) filters.push(`Search: “${viewState.search}”`);
  if (viewState.department) filters.push(`Department: ${viewState.department}`);
  if (viewState.status) {
    filters.push(`Status: ${STATUS_LABELS[viewState.status] || viewState.status}`);
  }
  if (viewState.lateOnly) filters.push("Late arrivals only");
  if (viewState.mode === "range") {
    filters.push(`Date range: ${viewState.startDate} → ${viewState.endDate}`);
  }
  if (viewState.mode === "roster" && viewState.search) {
    filters.push("Search spans all history");
  }
  return filters;
}

function updateFilterChips() {
  const labels = getActiveFilterLabels();
  if (adminElements.activeFilterBar) {
    adminElements.activeFilterBar.hidden = labels.length === 0;
  }
  if (adminElements.activeFilterChips) {
    adminElements.activeFilterChips.innerHTML = labels
      .map(label => `<span class="filter-chip">${esc(label)}</span>`)
      .join("");
  }
}

// A live-roster search deliberately spans all dates: admins need to find a
// person's history even when that person did not clock in today.
function getRecordQuery() {
  const query = {
    search: viewState.search || undefined,
    department: viewState.department || undefined,
    status: viewState.status || undefined,
    late_only: viewState.lateOnly || undefined,
    page: viewState.page,
    page_size: viewState.pageSize
  };

  if (viewState.mode === "range") {
    return {
      ...query,
      view: "history",
      start_date: viewState.startDate,
      end_date: viewState.endDate
    };
  }

  if (viewState.mode === "history" || viewState.search) {
    return { ...query, view: "history" };
  }

  return { ...query, view: "roster", date: getLocalDateString() };
}

function getMetricsQuery() {
  // KPI cards are intentionally today-scoped: their labels read "Present
  // Today" / "Clocked In Now". The records table owns the selected range.
  return { date: "today" };
}

function getExportFilters() {
  const filters = {
    department: viewState.department || undefined,
    status: viewState.status || undefined,
    late_only: viewState.lateOnly || undefined,
    search: viewState.search || undefined
  };

  if (viewState.mode === "range") {
    filters.start_date = viewState.startDate;
    filters.end_date = viewState.endDate;
  } else if (viewState.mode === "roster" && !viewState.search) {
    filters.date = getLocalDateString();
  }

  return filters;
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
    await Promise.all([
      loadMetrics(getMetricsQuery()),
      loadGeofenceSettings(),
      loadAttendanceRecords()
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
async function loadMetrics(filters) {
  try {
    const data = await ApiClient.getAdminMetrics(filters);
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

// Load Geofence Configuration — server is the only source of truth
// localStorage no longer overrides the server copy; the cache is read-only.
async function loadGeofenceSettings() {
  try {
    const geo = await ApiClient.getGeofence();
    if (adminElements.workplaceName) adminElements.workplaceName.value = geo.name || "Workplace Headquarters";
    if (adminElements.workplaceLat) adminElements.workplaceLat.value = geo.latitude;
    if (adminElements.workplaceLon) adminElements.workplaceLon.value = geo.longitude;
    if (adminElements.workplaceRadius) adminElements.workplaceRadius.value = geo.radius_meters;
    if (adminElements.workStartTime) adminElements.workStartTime.value = geo.work_start_time || "09:00";
  } catch (err) {
    console.error("Failed to load geofence:", err);
  }
}

// Geofence change is only allowed from the admin console with fresh auth.
async function requestGeofenceChange() {
  // Prompt for admin PIN re-entry before allowing a change.
  const confirmed = window.confirm(
    "Are you sure you want to change the workplace geofence?\n\n\n\nThis action will be audited and the new perimeter will take effect immediately."
  );
  if (!confirmed) return;
  
  const name = prompt("Enter new perimeter name:") || "Workplace Headquarters";
  const lat = parseFloat(prompt("Enter new latitude:"));
  const lon = parseFloat(prompt("Enter new longitude:"));
  const radius = parseFloat(prompt("Enter new radius in meters ( > 0 ):"));
  const startTime = prompt("Enter new work start time (HH:MM, default 09:00):") || "09:00";
  
  if (isNaN(lat) || isNaN(lon) || isNaN(radius) || radius <= 0) {
    showToast("Invalid input. Geofence change cancelled.", "error");
    return;
  }
  
  try {
    const payload = { name, latitude: lat, longitude: lon, radius_meters: radius, work_start_time: startTime };
    const response = await ApiClient.updateGeofence(payload);
    showToast("Geofence updated. Change logged and propagated to all admins.", "success");
  } catch (err) {
    showToast(err.message || "Failed to update geofence", "error");
  }
}


// Load one filtered page from the server.
async function loadAttendanceRecords(options = {}) {
  const seq = ++recordsRequestSeq;
  try {
    const response = await ApiClient.getAdminRecords(getRecordQuery());
    if (seq !== recordsRequestSeq) return; // stale response

    const records = Array.isArray(response) ? response : (response.records || []);
    recordsTotal = Array.isArray(response)
      ? records.length
      : Number(response.total ?? records.length);
    recordsTotalPages = Array.isArray(response)
      ? (recordsTotal > 0 ? 1 : 0)
      : Number(response.total_pages ?? 0);

    // The last page may disappear while the admin is viewing it (for example
    // after a clock-out changes a filter result). Clamp to the last page.
    if (recordsTotal === 0 && viewState.page > 1) {
      viewState.page = 1;
      return loadAttendanceRecords(options);
    }
    if (recordsTotalPages > 0 && viewState.page > recordsTotalPages) {
      viewState.page = recordsTotalPages;
      return loadAttendanceRecords(options);
    }

    allRecords = records;
    if (options.forceRender) lastRenderedJson = "";
    renderAttendanceTable(allRecords);
    updateRecordsSummary();
  } catch (err) {
    if (seq !== recordsRequestSeq) return;
    console.error("Failed to load records:", err);
    throw err;
  }
}

async function refreshRecords(options = {}) {
  try {
    await loadAttendanceRecords(options);
  } catch (err) {
    const msg = (err.message || "").toLowerCase();
    if (msg.includes("forbidden") || msg.includes("unauthorized") || msg.includes("access denied") || msg.includes("admin credentials required")) {
      handleAdminLogout();
      showAdminLoginGate("Administrative authentication required. Please sign in again.");
    } else {
      showToast(err.message || "Failed to load attendance records", "error");
    }
  }
}

function updateRecordsSummary() {
  const hasFilters = getActiveFilterLabels().length > 0;
  const page = Math.max(1, viewState.page);
  const totalPages = Math.max(1, recordsTotalPages);
  const pageStart = recordsTotal === 0 ? 0 : (page - 1) * viewState.pageSize + 1;
  const pageEnd = Math.min(page * viewState.pageSize, recordsTotal);

  if (adminElements.recordCount) {
    if (recordsTotal === 0) {
      adminElements.recordCount.textContent = hasFilters
        ? "No records match the active filters"
        : "No records for this view";
    } else {
      adminElements.recordCount.textContent = `${recordsTotal.toLocaleString()} ${recordsTotal === 1 ? "record" : "records"}${hasFilters ? " matching filters" : ""} · page ${page} of ${totalPages}`;
    }
  }

  if (adminElements.paginationSummary) {
    adminElements.paginationSummary.textContent = recordsTotal > 0
      ? `Showing ${pageStart}–${pageEnd} of ${recordsTotal.toLocaleString()}`
      : "No rows on this page";
  }
  if (adminElements.pageIndicator) {
    adminElements.pageIndicator.textContent = `Page ${page} of ${totalPages}`;
  }
  if (adminElements.tablePagination) {
    adminElements.tablePagination.hidden = recordsTotal === 0;
  }
  if (adminElements.btnPrevPage) {
    adminElements.btnPrevPage.disabled = page <= 1;
  }
  if (adminElements.btnNextPage) {
    adminElements.btnNextPage.disabled = recordsTotalPages === 0 || page >= recordsTotalPages;
  }
  if (adminElements.pageSizeSelect) {
    adminElements.pageSizeSelect.value = String(viewState.pageSize);
  }
}

// Populate the department select from the staff directory once per session.
async function loadDepartmentOptions() {
  if (departmentsLoaded || !adminElements.filterDepartment) return;
  try {
    const employees = await ApiClient.getEmployees();
    const departments = [...new Set((employees || [])
      .map(employee => (employee.department || "").trim())
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));

    departments.forEach(department => {
      const option = document.createElement("option");
      option.value = department;
      option.textContent = department;
      adminElements.filterDepartment.appendChild(option);
    });
    adminElements.filterDepartment.value = viewState.department;
    departmentsLoaded = true;
  } catch (err) {
    console.warn("Failed to load department options:", err);
  }
}

// Zero-Flicker Table Renderer with Complete All-Staff Status
function renderAttendanceTable(records) {
  const scroller = document.querySelector(".tbl-scroll");
  const scrollTop = scroller ? scroller.scrollTop : 0;
  const scrollLeft = scroller ? scroller.scrollLeft : 0;

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
    const hasFilters = getActiveFilterLabels().length > 0;
    let subText;
    if (hasFilters) {
      subText = "No records match the active filters. Adjust or clear them to see more.";
    } else if (viewState.mode === "history" || viewState.mode === "range") {
      subText = "No historical clock-in / clock-out events found in the database.";
    } else {
      subText = "No staff records found for the selected view.";
    }

    adminElements.attendanceTableBody.innerHTML = `
      <tr><td colspan="7">
        <div class="tbl-empty">
          <div class="tbl-empty-ic">📋</div>
          <div class="tbl-empty-msg">No attendance records found</div>
          <div class="tbl-empty-sub">${subText}</div>
        </div>
      </td></tr>`;
    if (scroller) {
      scroller.scrollTop = scrollTop;
      scroller.scrollLeft = scrollLeft;
    }
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
      ? `<span class="td-time">${esc(r.clock_in_time)}</span>`
      : `<span class="td-time td-na">—</span>`;

    const outCell = r.clock_out_time
      ? `<span class="td-time">${esc(r.clock_out_time)}</span>`
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
          <div class="td-av">${esc(initials(name))}</div>
          <div>
            <div class="td-name">${esc(name)}</div>
            ${dept ? `<div class="td-dept">${esc(dept)}</div>` : ''}
          </div>
        </div>
      </td>
      <td style="white-space:nowrap;color:var(--t2);font-size:.84rem;">${esc(r.date || 'Today')}</td>
      <td>${inCell}${gps}</td>
      <td>${outCell}</td>
      <td>${statusChip}</td>
      <td>${punctualityChip}</td>
      <td style="font-size:.78rem;color:var(--t3);">${esc(notesText)}</td>
    </tr>`;
  }).join('');

  // Keep the horizontal/vertical position stable during live refreshes.
  if (scroller) {
    scroller.scrollTop = scrollTop;
    scroller.scrollLeft = scrollLeft;
  }
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
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = null;
  recordsRequestSeq += 1; // ignore any in-flight response
  sessionStorage.removeItem(STORAGE_KEY_ADMIN_TOKEN);
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

        sessionStorage.setItem(STORAGE_KEY_ADMIN_TOKEN, token);
        sessionStorage.setItem(STORAGE_KEY_ADMIN_USER, JSON.stringify(user));

        showAdminDashboardUI();
        await refreshAllDashboardData();
        await loadDepartmentOptions();
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
        if (adminElements.geofenceSaveText) {
          adminElements.geofenceSaveText.textContent = `Permanent perimeter active: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        }
        showToast("Perimeter updated. Change logged and propagated to all admins.", "success");
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  // Use Current GPS as Office Perimeter — server-only write (no localStorage)
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
        if (adminElements.geofenceSaveText) {
          adminElements.geofenceSaveText.textContent = `Permanent perimeter active: ${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)}`;
        }
        showToast("Geofence updated from GPS location. Change logged and propagated to all admins.", "success");
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

  // Unified view switch: roster / history / date range
  if (adminElements.btnViewRoster) {
    adminElements.btnViewRoster.addEventListener("click", () => setViewMode("roster"));
  }
  if (adminElements.btnViewHistory) {
    adminElements.btnViewHistory.addEventListener("click", () => setViewMode("history"));
  }
  if (adminElements.btnViewRange) {
    adminElements.btnViewRange.addEventListener("click", () => setViewMode("range"));
  }

  // Date range inputs. Whichever bound is changed, the other is clamped so a
  // reversed range can never be sent or shown.
  const applyDateRange = (changedField) => {
    let start = adminElements.filterStartDate ? adminElements.filterStartDate.value : "";
    let end = adminElements.filterEndDate ? adminElements.filterEndDate.value : "";
    const today = getLocalDateString();

    if (!start && !end) {
      start = today;
      end = today;
    } else if (!start) {
      start = end;
    } else if (!end) {
      end = start;
    }

    if (start > end) {
      if (changedField === "start") {
        end = start;
      } else {
        start = end;
      }
      showToast("The start date cannot be after the end date. The range has been adjusted.", "warning");
    }

    viewState.mode = "range";
    viewState.startDate = start;
    viewState.endDate = end;
    viewState.page = 1;
    updateViewUI();
    updateFilterChips();
    lastRenderedJson = "";
    void refreshAllDashboardData();
  };

  if (adminElements.filterStartDate) {
    adminElements.filterStartDate.addEventListener("change", () => applyDateRange("start"));
  }
  if (adminElements.filterEndDate) {
    adminElements.filterEndDate.addEventListener("change", () => applyDateRange("end"));
  }

  // Server-side filters
  if (adminElements.filterDepartment) {
    adminElements.filterDepartment.addEventListener("change", (e) => {
      viewState.department = e.target.value;
      viewState.page = 1;
      updateFilterChips();
      void refreshRecords({ forceRender: true });
    });
  }
  if (adminElements.filterStatus) {
    adminElements.filterStatus.addEventListener("change", (e) => {
      viewState.status = e.target.value;
      viewState.page = 1;
      updateFilterChips();
      void refreshRecords({ forceRender: true });
    });
  }
  if (adminElements.filterLateOnly) {
    adminElements.filterLateOnly.addEventListener("change", (e) => {
      viewState.lateOnly = e.target.checked;
      viewState.page = 1;
      updateFilterChips();
      void refreshRecords({ forceRender: true });
    });
  }

  // Apply Filters: force an immediate fetch without waiting for the poll.
  if (adminElements.btnApplyFilters) {
    adminElements.btnApplyFilters.addEventListener("click", () => {
      viewState.page = 1;
      updateFilterChips();
      void refreshRecords({ forceRender: true });
    });
  }

  // Debounced search: the server searches all history so an employee who is
  // absent today can still be found.
  if (adminElements.searchEmployee) {
    adminElements.searchEmployee.addEventListener("input", (e) => {
      viewState.search = e.target.value.trim();
      viewState.page = 1;
      updateFilterChips();
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        void refreshRecords({ forceRender: true });
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  // Clear every filter and return to the live roster.
  if (adminElements.btnClearFilters) {
    adminElements.btnClearFilters.addEventListener("click", () => {
      clearTimeout(searchDebounceTimer);
      viewState.mode = "roster";
      viewState.startDate = getLocalDateString();
      viewState.endDate = viewState.startDate;
      viewState.search = "";
      viewState.department = "";
      viewState.status = "";
      viewState.lateOnly = false;
      viewState.page = 1;

      if (adminElements.searchEmployee) adminElements.searchEmployee.value = "";
      if (adminElements.filterDepartment) adminElements.filterDepartment.value = "";
      if (adminElements.filterStatus) adminElements.filterStatus.value = "";
      if (adminElements.filterLateOnly) adminElements.filterLateOnly.checked = false;

      updateViewUI();
      updateFilterChips();
      void refreshRecords({ forceRender: true });
      showToast("Filters cleared. Showing today's live roster.", "info");
    });
  }

  // Pagination
  if (adminElements.btnPrevPage) {
    adminElements.btnPrevPage.addEventListener("click", () => {
      if (viewState.page <= 1) return;
      viewState.page -= 1;
      void refreshRecords({ forceRender: true });
    });
  }
  if (adminElements.btnNextPage) {
    adminElements.btnNextPage.addEventListener("click", () => {
      if (recordsTotalPages === 0 || viewState.page >= recordsTotalPages) return;
      viewState.page += 1;
      void refreshRecords({ forceRender: true });
    });
  }
  if (adminElements.pageSizeSelect) {
    adminElements.pageSizeSelect.addEventListener("change", (e) => {
      const size = parseInt(e.target.value, 10);
      viewState.pageSize = Number.isFinite(size) && size > 0 ? size : 25;
      viewState.page = 1;
      void refreshRecords({ forceRender: true });
    });
  }

  // Export CSV: the session token is sent in the Authorization header, never in the URL
  if (adminElements.btnExportCsv) {
    adminElements.btnExportCsv.addEventListener("click", async () => {
      try {
        await ApiClient.exportCsv(getExportFilters());
        showToast("CSV export downloaded.", "success");
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  // Seed Demo Data
  if (adminElements.btnSeedDemo) {
    adminElements.btnSeedDemo.addEventListener("click", async () => {
      try {
        await ApiClient.seedDemo();
        showToast("Demo attendance records seeded across all 10 employees for today!", "success");
        clearTimeout(searchDebounceTimer);
        viewState.mode = "roster";
        viewState.startDate = getLocalDateString();
        viewState.endDate = viewState.startDate;
        viewState.search = "";
        viewState.department = "";
        viewState.status = "";
        viewState.lateOnly = false;
        viewState.page = 1;
        if (adminElements.searchEmployee) adminElements.searchEmployee.value = "";
        if (adminElements.filterDepartment) adminElements.filterDepartment.value = "";
        if (adminElements.filterStatus) adminElements.filterStatus.value = "";
        if (adminElements.filterLateOnly) adminElements.filterLateOnly.checked = false;
        updateViewUI();
        updateFilterChips();
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
  toast.innerHTML = `<div class="t-icon">${ADMIN_ICONS[type] || 'ℹ'}</div><span></span>`;
  toast.querySelector('span').textContent = message;
  adminElements.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(110%)';
    toast.style.transition = 'all .35s cubic-bezier(.4,0,1,1)';
    setTimeout(() => toast.remove(), 360);
  }, 4500);
}

document.addEventListener("DOMContentLoaded", initAdmin);
