"""
Unit and integration tests for Issue #67:
Workforce Management: per-employee shifts, grace periods, holidays, worked hours, and payroll export.
"""
import os
import io
import pytest
from datetime import datetime, timedelta
from fastapi.testclient import TestClient

from backend.main import app
from backend.database import init_db, get_db
from backend.security import create_admin_token, create_employee_token
from backend.services.schedules import (
    calculate_punctuality,
    calculate_shift_duration,
    get_employee_schedule_for_date,
    is_working_day,
    parse_days_of_week,
    is_period_locked,
    format_minutes_to_hours_mins,
)
from backend.services.reports import (
    generate_daily_report,
    generate_range_report,
    generate_timesheet_report,
    generate_payroll_export_data,
    export_payroll_csv,
    export_payroll_xlsx,
)


@pytest.fixture(autouse=True)
def setup_database():
    """Ensure clean initialized database for tests."""
    init_db()
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM payroll_periods")
    conn.commit()
    conn.close()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def admin_headers():
    token = create_admin_token("techAlhaji")
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def employee_headers():
    token = create_employee_token(1)  # EMP001
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Acceptance Criterion 1: A 14:00-22:00 employee is not marked Late every day
# ---------------------------------------------------------------------------

def test_afternoon_shift_employee_not_marked_late():
    """Employees working a 14:00 - 22:00 shift arriving at 14:02 are on-time."""
    afternoon_schedule = {
        "id": 2,
        "name": "Afternoon Shift",
        "start_time": "14:00",
        "end_time": "22:00",
        "grace_minutes": 5,
        "break_minutes": 60,
    }
    # Arriving at 14:02:00 is within 5-minute grace period
    is_late, late_mins, note = calculate_punctuality(afternoon_schedule, "14:02:00")
    assert is_late == 0
    assert late_mins == 0
    assert "On-time" in note

    # Arriving early at 13:55:00 is also on-time
    is_late_early, _, _ = calculate_punctuality(afternoon_schedule, "13:55:00")
    assert is_late_early == 0

    # Arriving late at 14:08:00 is marked late
    is_late_late, late_mins_late, _ = calculate_punctuality(afternoon_schedule, "14:08:00")
    assert is_late_late == 1
    assert late_mins_late == 8


# ---------------------------------------------------------------------------
# Acceptance Criterion 2: 09:00:30 arrival with 5m grace is On-time; 09:06 is Late
# ---------------------------------------------------------------------------

def test_seconds_precision_and_grace_period():
    """A 09:00:30 arrival with a 5-minute grace period is On-time; 09:06 is Late."""
    day_schedule = {
        "id": 1,
        "name": "Standard Day Shift",
        "start_time": "09:00",
        "end_time": "17:00",
        "grace_minutes": 5,
    }

    # 09:00:30 arrival is On-time (within grace period ending 09:05:00)
    is_late_30, late_mins_30, note_30 = calculate_punctuality(day_schedule, "09:00:30")
    assert is_late_30 == 0
    assert late_mins_30 == 0
    assert "On-time" in note_30

    # 09:05:00 exact boundary is On-time
    is_late_boundary, _, _ = calculate_punctuality(day_schedule, "09:05:00")
    assert is_late_boundary == 0

    # 09:06:00 is Late
    is_late_06, late_mins_06, note_06 = calculate_punctuality(day_schedule, "09:06:00")
    assert is_late_06 == 1
    assert late_mins_06 == 6
    assert "Late arrival" in note_06


# ---------------------------------------------------------------------------
# Acceptance Criterion 3: Weekends and holidays do not count as absences
# ---------------------------------------------------------------------------

def test_weekends_and_holidays_excluded_from_absences():
    """Weekends and holidays do not count as absences in range reports."""
    # A full week: 2026-11-09 (Monday) to 2026-11-15 (Sunday)
    # Total days = 7, working days = 5, weekend days = 2.
    conn = get_db()
    cursor = conn.cursor()
    # Ensure no attendance records exist for this future week
    cursor.execute("DELETE FROM attendance_records WHERE date >= '2026-11-09' AND date <= '2026-11-15'")
    # Remove any test holidays
    cursor.execute("DELETE FROM holidays WHERE date >= '2026-11-09' AND date <= '2026-11-15'")
    cursor.execute("SELECT COUNT(*) FROM employees")
    num_employees = cursor.fetchone()[0]
    conn.commit()
    conn.close()

    # Without holiday: only 5 working days count as absences (5 * num_employees), NOT 7 * num_employees!
    report_week = generate_range_report("2026-11-09", "2026-11-15")
    assert report_week["days"] == 7
    assert report_week["absent"] == num_employees * 5

    # Insert a company holiday on Wednesday (2026-11-11)
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO holidays (date, name, scope, is_working_day, created_at)
        VALUES ('2026-11-11', 'Midweek Public Holiday', 'company', 0, '2026-11-01T00:00:00')
    """)
    conn.commit()
    conn.close()

    # Now with Wednesday holiday: working days = 4, so absences = 4 * num_employees!
    report_holiday_week = generate_range_report("2026-11-09", "2026-11-15")
    assert report_holiday_week["absent"] == num_employees * 4

    # Cleanup test holiday
    conn = get_db()
    conn.cursor().execute("DELETE FROM holidays WHERE name = 'Midweek Public Holiday'")
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Acceptance Criterion 4: Payroll export reconciles with locked timesheet totals
# ---------------------------------------------------------------------------

def test_payroll_export_reconciles_with_timesheet_and_locked_periods(client, admin_headers):
    """The payroll export reconciles with timesheet totals for a locked period."""
    start_date = "2026-11-02"
    end_date = "2026-11-08"

    # Create and lock a pay period for this week
    res = client.post("/api/admin/payroll/periods", json={
        "name": "Week 45 Payroll",
        "start_date": start_date,
        "end_date": end_date,
        "notes": "Testing reconciliation"
    }, headers=admin_headers)
    assert res.status_code == 200
    period_id = res.json()["period"]["id"]

    # Lock period
    res_lock = client.post(f"/api/admin/payroll/periods/{period_id}/lock", headers=admin_headers)
    assert res_lock.status_code == 200
    assert res_lock.json()["period"]["status"] == "LOCKED"

    # Fetch timesheets and payroll export data
    ts = generate_timesheet_report(start_date=start_date, end_date=end_date)
    rows, payroll_summary = generate_payroll_export_data(start_date, end_date)

    # Reconciliation assertions:
    assert payroll_summary["total_scheduled_days"] == ts["summary"]["total_scheduled_days"]
    assert payroll_summary["total_worked_days"] == ts["summary"]["total_worked_days"]
    assert payroll_summary["total_absent_days"] == ts["summary"]["total_absent_days"]
    assert payroll_summary["total_worked_minutes"] == ts["summary"]["total_worked_minutes"]
    assert payroll_summary["total_overtime_minutes"] == ts["summary"]["total_overtime_minutes"]
    assert payroll_summary["total_break_minutes"] == ts["summary"]["total_break_minutes"]
    assert payroll_summary["verified_presence_minutes"] == ts["summary"]["verified_presence_minutes"]

    # Verify CSV export stream contains period summary and reconciles
    csv_content = export_payroll_csv(start_date, end_date)
    assert "--- PERIOD SUMMARY ---" in csv_content
    assert f"Total Scheduled Days,{payroll_summary['total_scheduled_days']}" in csv_content
    assert f"Total Absences (Excl. Holidays/Weekends),{payroll_summary['total_absent_days']}" in csv_content

    # Verify XLSX generation
    xlsx_bytes = export_payroll_xlsx(start_date, end_date)
    assert len(xlsx_bytes) > 2000

    # Locked period prevents further clock-in on dates within the period
    conn = get_db()
    locked, lock_info = is_period_locked(conn.cursor(), "2026-11-04")
    assert locked is True
    assert lock_info["id"] == period_id
    conn.close()


# ---------------------------------------------------------------------------
# Additional Features & Edge Cases
# ---------------------------------------------------------------------------

def test_duration_and_worked_time_display():
    """Worked time calculates correctly and displays 'You worked 7 h 42 m today'."""
    sched = {
        "start_time": "09:00",
        "end_time": "17:00",
        "break_minutes": 60,
        "break_is_paid": 0,
        "required_minutes": 420,
    }
    # 09:00 to 17:42 is 8 hours 42 minutes (522 min) elapsed.
    # Minus 60 min break = 462 min = 7 hours 42 minutes.
    dur = calculate_shift_duration(
        "2026-11-11T09:00:00+01:00",
        "2026-11-11T17:42:00+01:00",
        sched
    )
    assert dur["worked_minutes"] == 462
    assert dur["worked_display"] == "7 h 42 m"
    assert format_minutes_to_hours_mins(dur["worked_minutes"]) == "7 h 42 m"


def test_overnight_shift_calculation():
    """Overnight shifts (22:00 to 06:00) crossing midnight calculate worked hours properly."""
    overnight_sched = {
        "name": "Night Shift",
        "start_time": "22:00",
        "end_time": "06:00",
        "is_overnight": 1,
        "grace_minutes": 5,
        "break_minutes": 60,
        "break_is_paid": 0,
        "overtime_threshold_daily_minutes": 420,
    }
    # Arriving at 21:58 for a 22:00 shift is On-time
    is_late, _, _ = calculate_punctuality(overnight_sched, "21:58:00")
    assert is_late == 0

    # Clocking in 2026-11-11 at 22:00, clocking out 2026-11-12 at 06:30
    # Elapsed = 8.5 hours = 510 minutes. Minus 60 min break = 450 minutes (7 h 30 m).
    # Overtime threshold = 420 minutes -> 30 min overtime.
    dur = calculate_shift_duration(
        "2026-11-11T22:00:00+01:00",
        "2026-11-12T06:30:00+01:00",
        overnight_sched
    )
    assert dur["worked_minutes"] == 450
    assert dur["worked_display"] == "7 h 30 m"
    assert dur["overtime_minutes"] == 30


def test_admin_schedules_crud(client, admin_headers):
    """Admin can create, list, and update shift schedules."""
    # Create
    res = client.post("/api/admin/schedules", json={
        "name": "Weekend Roster Shift",
        "start_time": "10:00",
        "end_time": "18:00",
        "days_of_week": "6,7",
        "grace_minutes": 10,
        "break_minutes": 45,
        "required_minutes": 435,
    }, headers=admin_headers)
    assert res.status_code == 200
    sched_id = res.json()["schedule"]["id"]

    # List
    res_list = client.get("/api/admin/schedules", headers=admin_headers)
    assert res_list.status_code == 200
    names = [s["name"] for s in res_list.json()]
    assert "Weekend Roster Shift" in names

    # Update
    res_up = client.put(f"/api/admin/schedules/{sched_id}", json={
        "name": "Weekend Special Shift",
        "grace_minutes": 15
    }, headers=admin_headers)
    assert res_up.status_code == 200
    assert res_up.json()["schedule"]["grace_minutes"] == 15

    # Delete
    res_del = client.delete(f"/api/admin/schedules/{sched_id}", headers=admin_headers)
    assert res_del.status_code == 200


def test_locked_period_rejects_clock_in_and_clock_out(client, admin_headers, employee_headers):
    """When a payroll period is locked, employees cannot clock in or out for dates in that period."""
    from backend.config import get_today_str

    today = get_today_str()

    # Create and lock pay period covering today
    res = client.post("/api/admin/payroll/periods", json={
        "name": "Today Locked Pay Period",
        "start_date": today,
        "end_date": today,
    }, headers=admin_headers)
    assert res.status_code == 200
    p_id = res.json()["period"]["id"]

    res_lock = client.post(f"/api/admin/payroll/periods/{p_id}/lock", headers=admin_headers)
    assert res_lock.status_code == 200

    # Attempt to clock in during locked period
    res_in = client.post("/api/attendance/clock-in", json={
        "latitude": 6.509309,
        "longitude": 3.374993,
        "accuracy": 10.0,
    }, headers=employee_headers)
    assert res_in.status_code == 403
    assert "locked" in res_in.json()["detail"].lower()

    # Unlock period to clean up
    client.post(f"/api/admin/payroll/periods/{p_id}/unlock", headers=admin_headers)


def test_employee_dashboard_status_endpoint(client, employee_headers):
    """Employee status endpoint returns worked time display and assigned schedule."""
    res = client.get("/api/attendance/status/1", headers=employee_headers)
    assert res.status_code == 200
    data = res.json()
    assert "worked_minutes" in data
    assert "worked_time_display" in data
    assert "schedule" in data
    assert data["schedule"]["name"] is not None


def test_timesheets_api_filtering(client, admin_headers):
    """Admin timesheets endpoint returns daily, weekly, and monthly views with overtime & presence."""
    # Daily view
    res_daily = client.get("/api/admin/timesheets?period=daily", headers=admin_headers)
    assert res_daily.status_code == 200
    data_daily = res_daily.json()
    assert data_daily["period"] == "daily"
    assert "summary" in data_daily
    assert "employees" in data_daily

    # Weekly view
    res_weekly = client.get("/api/admin/timesheets?period=weekly", headers=admin_headers)
    assert res_weekly.status_code == 200
    assert res_weekly.json()["period"] == "weekly"

    # Monthly view
    res_monthly = client.get("/api/admin/timesheets?period=monthly", headers=admin_headers)
    assert res_monthly.status_code == 200
    assert res_monthly.json()["period"] == "monthly"

