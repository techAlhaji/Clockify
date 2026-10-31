/**
 * Clockify — Admin Dashboard Controller (admin.js)
 * Stat tiles, geofence management, month-navigable attendance log & CSV export.
 * Requires api.js (ApiClient) loaded first.
 */

const AdminApp = (() => {
  const REFRESH_INTERVAL_MS = 30000;
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  const els = {
    topbarDate: document.getElementById("topbarDate"),
    liveClock: document.getElementById("liveClock"),

    kpiTotalEmployees: document.getElementById("kpiTotalEmployees"),
    kpiClockedInToday: document.getElementById("kpiClockedInToday"),
    kpiLateArrivals: document.getElementById("kpiLateArrivals"),
    kpiOutsideAttempts: document.getElementById("kpiOutsideAttempts"),

    geoName: document.getElementById("geoName"),
    geoCoords: document.getElementById("geoCoords"),
    geoRadius: document.getElementById("geoRadius"),
    geoUpdated: document.getElementById("geoUpdated"),
    btnToggleEdit: document.getElementById("btnToggleEdit"),
    geofenceForm: document.getElementById("geofenceForm"),
    workplaceName: document.getElementById("workplaceName"),
    workplaceLat: document.getElementById("workplaceLat"),
    workplaceLon: document.getElementById("workplaceLon"),
    workplaceRadius: document.getElementById("workplaceRadius"),
    btnUseCurrentLocation: document.getElementById("btnUseCurrentLocation"),
    btnSaveGeofence: document.getElementById("btnSaveGeofence"),

    recordCount: document.getElementById("recordCount"),
    monthLabel: document.getElementById("monthLabel"),
    btnPrevMonth: document.getElementById("btnPrevMonth"),
    btnNextMonth: document.getElementById("btnNextMonth"),
    btnToday: document.getElementById("btnToday"),
    searchEmployee: document.getElementById("searchEmployee"),
    btnExportCsv: document.getElementById("btnExportCsv"),
    navExport: document.getElementById("navExport"),
    btnSeedDemo: document.getElementById("btnSeedDemo"),
    attendanceTableBody: document.getElementById("attendanceTableBody"),

    adminGate: document.getElementById("adminGate"),
    gateForm: document.getElementById("gateForm"),
    gatePin: document.getElementById("gatePin"),
    gateError: document.getElementById("gateError"),
    btnUnlock: document.getElementById("btnUnlock"),

    toastContainer: document.getElementById("toastContainer")
  };

  const state = {
    allRecords: [],
    currentGeofence: null,
    viewMonth: new Date(),
    expandedId: null,
    locked: true,
    refreshTimer: null
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const pad = (n) => String(n).padStart(2, "0");
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  function countUp(el, target, suffix = "") {
    const start = parseInt(el.textContent, 10) || 0;
    if (start === target) {
      el.textContent = target + suffix;
      return;
    }
    const duration = 500;
    const t0 = performance.now();
    function frame(t) {
      const p = Math.min((t - t0) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(start + (target - start) * eased) + suffix;
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ================= Initialization =================
  async function init() {
    document.documentElement.style.scrollBehavior = "smooth";
    startClock();
    bindEvents();
    renderMonthLabel();

    const storedPin = sessionStorage.getItem("clockify_admin_pin");
    if (storedPin) {
      try {
        await ApiClient.adminLogin(storedPin);
        await unlockDashboard();
      } catch {
        sessionStorage.removeItem("clockify_admin_pin");
        showGate("Session expired — please unlock again.");
      }
    } else {
      showGate();
    }
  }

  // ================= Admin PIN Gate =================
  function showGate(message) {
    state.locked = true;
    els.adminGate.hidden = false;
    if (message) {
      els.gateError.textContent = message;
      els.gateError.classList.remove("hidden");
    } else {
      els.gateError.textContent = "";
      els.gateError.classList.add("hidden");
    }
    els.gatePin.value = "";
    setTimeout(() => els.gatePin.focus(), 60);
  }

  async function attemptUnlock() {
    const pin = els.gatePin.value.trim();
    if (!pin) return;

    els.btnUnlock.disabled = true;
    els.btnUnlock.textContent = "Verifying…";
    els.gateError.classList.add("hidden");

    try {
      await ApiClient.adminLogin(pin);
      sessionStorage.setItem("clockify_admin_pin", pin);
      await unlockDashboard();
    } catch (err) {
      els.gateError.textContent = err.message || "Incorrect PIN. Access denied.";
      els.gateError.classList.remove("hidden");
    } finally {
      els.btnUnlock.disabled = false;
      els.btnUnlock.textContent = "Unlock Dashboard";
    }
  }

  async function unlockDashboard() {
    state.locked = false;
    els.adminGate.hidden = true;
    await Promise.all([loadKpis(), loadGeofence(), loadRecords()]);
    if (!state.refreshTimer) {
      state.refreshTimer = setInterval(refreshLiveData, REFRESH_INTERVAL_MS);
    }
  }

  function handleAuthError(err) {
    if (err && err.status === 401) {
      sessionStorage.removeItem("clockify_admin_pin");
      showGate("Session expired — please unlock again.");
      return true;
    }
    return false;
  }

  async function refreshLiveData() {
    if (state.locked) return;
    await Promise.all([loadKpis({ silent: true }), loadRecords({ silent: true })]);
  }

  function startClock() {
    function tick() {
      const now = new Date();
      els.liveClock.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      els.topbarDate.textContent = now.toLocaleDateString([], {
        weekday: "long", year: "numeric", month: "long", day: "numeric"
      });
    }
    tick();
    setInterval(tick, 1000);
  }

  // ================= KPI Stat Tiles =================
  async function loadKpis({ silent } = {}) {
    try {
      const [employees, metrics] = await Promise.all([
        ApiClient.getEmployees(),
        ApiClient.getAdminMetrics()
      ]);
      countUp(els.kpiTotalEmployees, employees.length);
      countUp(els.kpiClockedInToday, metrics.total_present ?? 0);
      countUp(els.kpiLateArrivals, metrics.late_arrivals ?? 0);
      countUp(els.kpiOutsideAttempts, metrics.outside_boundary_attempts ?? 0);
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) showToast("Failed to load dashboard metrics.", "error");
    }
  }

  // ================= Workplace / Geofence Card =================
  function renderGeofenceSummary(geo) {
    els.geoName.textContent = geo.name || "—";
    els.geoCoords.textContent = `${geo.latitude ?? "—"}, ${geo.longitude ?? "—"}`;
    els.geoRadius.textContent = `${geo.radius_meters ?? "—"} m radius`;
    const updated = geo.updated_at ? new Date(geo.updated_at) : null;
    els.geoUpdated.textContent = updated && !isNaN(updated)
      ? `Updated ${updated.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
      : "Updated —";
  }

  async function loadGeofence({ silent } = {}) {
    try {
      const geo = await ApiClient.getGeofence();
      state.currentGeofence = geo;
      renderGeofenceSummary(geo);
      els.workplaceName.value = geo.name ?? "";
      els.workplaceLat.value = geo.latitude ?? "";
      els.workplaceLon.value = geo.longitude ?? "";
      els.workplaceRadius.value = geo.radius_meters ?? "";
    } catch (err) {
      if (!silent) showToast("Could not load saved geofence; showing defaults.", "warning");
    }
  }

  function readGeofenceForm() {
    return {
      name: els.workplaceName.value.trim(),
      latitude: parseFloat(els.workplaceLat.value),
      longitude: parseFloat(els.workplaceLon.value),
      radius_meters: parseFloat(els.workplaceRadius.value)
    };
  }

  function validateGeofence(payload) {
    if (!payload.name) return "Workplace name is required.";
    if (isNaN(payload.latitude) || payload.latitude < -90 || payload.latitude > 90)
      return "Latitude must be a number between -90 and 90.";
    if (isNaN(payload.longitude) || payload.longitude < -180 || payload.longitude > 180)
      return "Longitude must be a number between -180 and 180.";
    if (isNaN(payload.radius_meters) || payload.radius_meters <= 0)
      return "Radius must be a positive number of meters.";
    return null;
  }

  async function saveGeofence() {
    const payload = readGeofenceForm();
    const error = validateGeofence(payload);
    if (error) return showToast(error, "error");

    try {
      const response = await ApiClient.updateGeofence({
        ...payload,
        work_start_time: state.currentGeofence?.work_start_time || "09:00"
      });
      state.currentGeofence = response.geofence || { ...state.currentGeofence, ...payload, updated_at: new Date().toISOString() };
      renderGeofenceSummary(state.currentGeofence);
      els.geofenceForm.classList.add("hidden");
      els.btnToggleEdit.textContent = "Edit Geofence";
      showToast("Geofence updated successfully.", "success");
    } catch (err) {
      if (handleAuthError(err)) return;
      showToast(err.message || "Failed to update geofence.", "error");
    }
  }

  function useCurrentLocation() {
    if (!("geolocation" in navigator)) {
      return showToast("Geolocation is not supported by this browser.", "error");
    }

    showToast("Detecting your current location…", "warning");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        els.workplaceLat.value = position.coords.latitude.toFixed(6);
        els.workplaceLon.value = position.coords.longitude.toFixed(6);
        showToast(
          `Location captured (±${Math.round(position.coords.accuracy)}m). Click Save Changes to apply.`,
          "success"
        );
      },
      (err) => {
        const message =
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Allow GPS access in your browser settings and try again."
            : err.code === err.TIMEOUT
              ? "GPS request timed out. Please try again."
              : "Unable to retrieve your current location.";
        showToast(message, "error");
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  }

  // ================= Attendance Log =================
  async function loadRecords({ silent } = {}) {
    try {
      state.allRecords = await ApiClient.getAdminRecords();
      renderTable();
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) showToast("Failed to load attendance records.", "error");
      state.allRecords = [];
      renderTable();
    }
  }

  function renderMonthLabel() {
    const d = state.viewMonth;
    els.monthLabel.textContent = `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
  }

  function visibleRecords() {
    const y = state.viewMonth.getFullYear();
    const m = pad(state.viewMonth.getMonth() + 1);
    const prefix = `${y}-${m}-`;
    const term = els.searchEmployee.value.trim().toLowerCase();

    return state.allRecords
      .filter((r) => (r.date || "").startsWith(prefix))
      .filter(
        (r) =>
          !term ||
          (r.employee_name && r.employee_name.toLowerCase().includes(term)) ||
          (r.department && r.department.toLowerCase().includes(term))
      )
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.clock_in_time || "").localeCompare(a.clock_in_time || ""));
  }

  function workingHours(r) {
    if (!r.clock_in_time || !r.clock_out_time) return null;
    const [inH, inM] = r.clock_in_time.split(":").map(Number);
    const [outH, outM] = r.clock_out_time.split(":").map(Number);
    const mins = outH * 60 + outM - (inH * 60 + inM);
    if (mins <= 0) return null;
    return `${Math.floor(mins / 60)}h ${pad(mins % 60)}m`;
  }

  function initials(name) {
    return (name || "?")
      .split(" ")
      .map((n) => n[0])
      .join("")
      .substring(0, 2)
      .toUpperCase();
  }

  const clockInIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
  const clockOutIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';

  function renderTable() {
    const records = visibleRecords();
    const monthName = `${MONTH_NAMES[state.viewMonth.getMonth()]} ${state.viewMonth.getFullYear()}`;
    els.recordCount.textContent = records.length === 1
      ? "1 record found"
      : `${records.length} records found`;
    els.monthLabel.textContent = monthName;

    if (!records.length) {
      els.attendanceTableBody.innerHTML =
        `<tr><td colspan="6" class="table-empty">No attendance records for ${escapeHtml(monthName)}.</td></tr>`;
      return;
    }

    els.attendanceTableBody.innerHTML = records
      .map((r) => {
        const wh = workingHours(r);
        const isOpen = state.expandedId === r.id;
        const detail = `
        <tr class="row-detail" ${isOpen ? "" : "hidden"}>
          <td colspan="6">
            <div class="detail-grid">
              <div class="detail-item">
                <span class="detail-label">Status</span>
                <span class="chip ${r.status === "CLOCKED_IN" ? "on-site" : "done"}">
                  ${r.status === "CLOCKED_IN" ? "On Site" : "Shift Completed"}
                </span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Punctuality</span>
                <span class="chip ${r.is_late ? "late" : "ontime"}">${r.is_late ? "Late Arrival" : "On Time"}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Clock-In Position</span>
                <span class="detail-value">${r.clock_in_distance != null ? `${r.clock_in_distance}m from boundary` : "—"}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Clock-Out Position</span>
                <span class="detail-value">${r.clock_out_distance != null ? `${r.clock_out_distance}m from boundary` : "—"}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Notes</span>
                <span class="detail-value">${escapeHtml(r.notes || "Verified")}</span>
              </div>
            </div>
          </td>
        </tr>`;

        return `
        <tr class="row-main ${isOpen ? "open" : ""}" data-id="${r.id}">
          <td>
            <div class="emp-cell">
              <span class="emp-avatar">${escapeHtml(initials(r.employee_name))}</span>
              <span>
                <span class="emp-name">${escapeHtml(r.employee_name || "Staff #" + r.employee_id)}</span>
                <div class="emp-dept">${escapeHtml(r.department || "")}</div>
              </span>
            </div>
          </td>
          <td>${escapeHtml(r.date || "")}</td>
          <td>
            ${r.clock_in_time
              ? `<span class="time-cell time-in ${r.is_late ? "is-late" : ""}">${clockInIcon}${escapeHtml(r.clock_in_time)}</span>`
              : '<span class="time-cell time-none">—</span>'}
          </td>
          <td>
            ${r.clock_out_time
              ? `<span class="time-cell time-out">${clockOutIcon}${escapeHtml(r.clock_out_time)}</span>`
              : '<span class="time-cell time-none">In progress</span>'}
          </td>
          <td>${wh ? `<span class="work-hrs">${wh}</span>` : '<span class="time-cell time-none">—</span>'}</td>
          <td><span class="row-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span></td>
        </tr>
        ${detail}`;
      })
      .join("");
  }

  // ================= CSV Export =================
  async function exportCsv() {
    try {
      const url = `${window.location.origin}/api/admin/export/csv`;
      const response = await fetch(url, { headers: ApiClient.adminHeaders() });
      if (response.status === 401) {
        handleAuthError({ status: 401 });
        throw new Error("Admin PIN required — please unlock again.");
      }
      if (!response.ok) throw new Error("CSV export failed on the server.");

      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^";]+)"?/);
      const filename = match ? match[1] : "attendance_report_all.csv";

      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);

      showToast("CSV report downloaded.", "success");
    } catch (err) {
      showToast(err.message || "CSV export failed.", "error");
    }
  }

  // ================= Demo Seed =================
  async function seedDemo() {
    try {
      await ApiClient.seedDemo();
      showToast("Sample attendance records generated.", "success");
      await refreshLiveData();
    } catch (err) {
      if (handleAuthError(err)) return;
      showToast(err.message || "Failed to generate sample data.", "error");
    }
  }

  // ================= Events =================
  function bindEvents() {
    els.gateForm.addEventListener("submit", (e) => {
      e.preventDefault();
      attemptUnlock();
    });

    els.btnSaveGeofence.addEventListener("click", saveGeofence);
    els.btnUseCurrentLocation.addEventListener("click", useCurrentLocation);

    els.btnToggleEdit.addEventListener("click", () => {
      const isHidden = els.geofenceForm.classList.toggle("hidden");
      els.btnToggleEdit.textContent = isHidden ? "Edit Geofence" : "Close Editor";
    });

    els.btnPrevMonth.addEventListener("click", () => {
      state.viewMonth = new Date(state.viewMonth.getFullYear(), state.viewMonth.getMonth() - 1, 1);
      renderMonthLabel();
      renderTable();
    });

    els.btnNextMonth.addEventListener("click", () => {
      state.viewMonth = new Date(state.viewMonth.getFullYear(), state.viewMonth.getMonth() + 1, 1);
      renderMonthLabel();
      renderTable();
    });

    els.btnToday.addEventListener("click", () => {
      state.viewMonth = new Date();
      renderMonthLabel();
      renderTable();
    });

    els.searchEmployee.addEventListener("input", renderTable);

    els.btnExportCsv.addEventListener("click", exportCsv);
    if (els.navExport) {
      els.navExport.addEventListener("click", (e) => {
        e.preventDefault();
        setActiveNav(els.navExport);
        exportCsv();
      });
    }

    if (els.btnSeedDemo) els.btnSeedDemo.addEventListener("click", seedDemo);

    els.attendanceTableBody.addEventListener("click", (e) => {
      const row = e.target.closest(".row-main");
      if (!row) return;
      const id = parseInt(row.dataset.id, 10);
      state.expandedId = state.expandedId === id ? null : id;
      renderTable();
    });
  }

  function setActiveNav(activeLink) {
    document.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));
    activeLink.classList.add("active");
  }

  document.querySelectorAll(".nav-item").forEach((el) => {
    el.addEventListener("click", () => setActiveNav(el));
  });

  // ================= Toast =================
  function showToast(message, type = "info") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    els.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(8px)";
      toast.style.transition = "all 0.3s ease";
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", AdminApp.init);
