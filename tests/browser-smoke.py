"""Render the real dashboard in headless Chrome with deterministic GPS samples."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
html = (root / 'frontend/index.html').read_text()
app = (root / 'frontend/js/app.js').read_text().replace(
    'document.addEventListener("DOMContentLoaded", init);', '')
setup = '''
let browserWatch, browserFailure, browserCleared = 0;
const fix = meters => ({ coords: {latitude: meters / 6371000 * 180 / Math.PI,
  longitude: 0, accuracy: 10}, timestamp: Date.now() });
Object.defineProperty(navigator, 'geolocation', {value: {
  watchPosition(ok, fail) { browserWatch = ok; browserFailure = fail; return 0; },
  clearWatch() { browserCleared++; },
  getCurrentPosition(ok) { ok(fix(24)); }
}});
'''
checks = '''
(async () => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  AppState.currentEmployee = {id: 1};
  AppState.workplace = {name: 'Office', latitude: 0, longitude: 0,
    radius_meters: 150, max_allowed_accuracy_meters: 80};
  elements.employeeLoginGate.style.display = 'none';
  elements.employeeDashboard.style.display = 'flex';
  setupEventListeners(); startLocationWatch(); browserWatch(fix(24));
  check(elements.distanceValue.textContent.includes('You are 24 m from the office — inside the 150 m boundary'), 'inside copy');
  check(ClockifyLocation.getSnapshot().verifiedPresence, 'verified presence');
  browserWatch(fix(124));
  check(ClockifyLocation.getSnapshot().sample.distance === 124, '100 meter movement');
  browserFailure({code: 1});
  check(!ClockifyLocation.getSnapshot().fresh && geoWatchId === null, 'permission revocation');
  elements.btnRefreshLocation.click();
  await Promise.resolve(); await Promise.resolve();
  check(ClockifyLocation.getSnapshot().fresh && geoWatchId === 0, 'retry');
  check(getComputedStyle(elements.btnRefreshLocation).display !== 'none', 'visible retry');
  AppState.shiftStatus = 'CLOCKED_OUT'; stopLocationWatch('complete');
  check(geoWatchId === null && geoFreshnessTimer === null && browserCleared >= 2, 'completed cleanup');
  showLoginGate();
  check(ClockifyLocation.getSnapshot().sample === null, 'logout');
  document.body.dataset.smoke = 'PASS';
})().catch(error => { document.body.dataset.smoke = 'FAIL: ' + error.message; });
'''
for name in ['api', 'geo', 'app']:
    content = (root / f'frontend/js/{name}.js').read_text()
    if name == 'geo':
        content = setup + content
    if name == 'app':
        content = app + checks
    html = html.replace(f'<script src="/static/js/{name}.js"></script>', '<script>' + content + '</script>')
html = html.replace('<link rel="stylesheet" href="/static/css/style.css">',
                    '<style>' + (root / 'frontend/css/style.css').read_text() + '</style>')
with tempfile.TemporaryDirectory(prefix='clockify-browser-') as directory:
    page = Path(directory) / 'radar.html'
    page.write_text(html)
    result = subprocess.run(['google-chrome', '--headless', '--no-sandbox', '--disable-gpu',
                             '--disable-background-networking', '--no-first-run',
                             '--user-data-dir=' + directory + '/profile',
                             '--virtual-time-budget=1000', '--dump-dom', page.as_uri()],
                            capture_output=True, text=True, timeout=30)
    if result.returncode or 'data-smoke="PASS"' not in result.stdout:
        import re
        state = re.search(r'data-smoke="([^"]*)"', result.stdout)
        raise SystemExit(state.group(1) if state else result.stderr[-2000:])
    print('Chrome DOM smoke: PASS (movement, permission revocation, retry, cleanup, logout)')
