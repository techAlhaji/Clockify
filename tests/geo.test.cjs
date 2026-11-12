const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const vm = require('node:vm');
const Geo = require('../frontend/js/geo.js');

function browser() {
  let success, failure;
  const cleared = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { geolocation: {
    watchPosition(ok, fail) { success = ok; failure = fail; return 0; },
    getCurrentPosition(ok) { ok({ coords: { latitude: 0, longitude: 0, accuracy: 10.005 }, timestamp: 123 }); },
    clearWatch(id) { cleared.push(id); }
  } } });
  return { fix(latitude = 0, timestamp = 123) { success({ coords: { latitude, longitude: 0, accuracy: 10.005 }, timestamp }); },
    error(code) { failure({ code }); }, cleared };
}

test('client matches actual Python verifier across boundaries and accuracy limits', () => {
  const latitude = meters => meters / 6371000 * 180 / Math.PI;
  const cases = [];
  for (const distance of [0, 24.99, 25, 100, 139.99, 140, 140.01, 150, 150.01]) {
    for (const accuracy of [null, -1, 0, 9.99, 10, 10.005, 10.01, 80, 80.001]) {
      cases.push([latitude(distance), 0, 0, 0, 150, accuracy, 80]);
    }
  }
  cases.push([6.509309, 3.374993, 6.5102, 3.3758, 150, 12.345, 30]);
  cases.push([6.509309, 3.374993, 6.5102, 3.3758, 145.62, 12.345, 30]);
  for (let i = 0; i < 100; i++) {
    cases.push([6.509309 + i * 0.000013, 3.374993 - i * 0.000007,
      6.509309, 3.374993, 150, i * 0.8137, 80]);
  }
  const expected = JSON.parse(execFileSync('python3', ['-B', '-c',
    'import json,sys; from backend.services.geofence import verify_geofence; print(json.dumps([verify_geofence(*c) for c in json.load(sys.stdin)]))'],
    { cwd: require('node:path').resolve(__dirname, '..'), input: JSON.stringify(cases), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }));
  cases.forEach((args, i) => {
    const actual = Geo.verifyGeofence(...args);
    assert.deepEqual(actual, { distance: expected[i].distance_meters,
      effectiveDistance: expected[i].effective_distance_meters,
      isInside: expected[i].is_inside, reason: expected[i].reason }, JSON.stringify(args));
  });
  assert.equal(Geo.verifyGeofence(latitude(140), 0, 0, 0, 150, 10, 80).isInside, true);
  assert.equal(Geo.verifyGeofence(latitude(140), 0, 0, 0, 150, 10.01, 80).isInside, false);
});

test('watcher emits first fix, then at 30 seconds OR 25 meters; preserves precision', () => {
  const mock = browser(), samples = [];
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const id = Geo.watchDistanceToOffice(0, 0, 150, x => samples.push(x),
      { minIntervalMs: 30000, minMovementMeters: 25, maxAccuracy: 80 });
    mock.fix();
    assert.equal(samples[0].accuracy, 10.005);
    assert.equal(samples[0].timestamp, 123);
    now += 29999; mock.fix(); assert.equal(samples.length, 1);
    now += 1; mock.fix(); assert.equal(samples.length, 2);
    now += 1; mock.fix(24.98 / 6371000 * 180 / Math.PI); assert.equal(samples.length, 2);
    mock.fix(24.999 / 6371000 * 180 / Math.PI); assert.equal(samples.length, 2);
    mock.fix(25 / 6371000 * 180 / Math.PI); assert.equal(samples.length, 3);
    mock.error(1); assert.equal(samples.at(-1).code, 1);
    mock.fix(25 / 6371000 * 180 / Math.PI); assert.equal(samples.length, 5);
    Geo.clearWatch(id); assert.deepEqual(mock.cleared, [0]);
  } finally { Date.now = originalNow; }
});

test('one-shot and raw watcher retain raw accuracy and original timestamp', async () => {
  const mock = browser();
  assert.deepEqual(await Geo.getCurrentPosition(), {
    latitude: 0, longitude: 0, accuracy: 10.005, timestamp: 123, lowAccuracy: false
  });
  let fix;
  Geo.watchPosition(x => { fix = x; });
  mock.fix(0, 456);
  assert.equal(fix.timestamp, 456);
  assert.equal(fix.accuracy, 10.005);
});

test('adapted PR lifecycle stops hidden, signed-out and completed tracking', () => {
  const nodes = new Map();
  const node = () => ({ classList: { add() {}, remove() {} }, style: {}, addEventListener() {} });
  let watches = 0, clears = 0;
  const context = vm.createContext({
    document: { hidden: false, getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, addEventListener() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    window: { addEventListener() {}, dispatchEvent() {} }, escapeHtml: String, console, Date,
    setInterval() { return 1; }, clearInterval() {},
    GeoService: { watchDistanceToOffice() { watches++; return 0; }, clearWatch() { clears++; } }
  });
  vm.runInContext(fs.readFileSync(require('node:path').resolve(__dirname, '../frontend/js/app.js'), 'utf8'), context);
  vm.runInContext(`AppState.currentEmployee = {id: 1}; AppState.workplace = {latitude: 0, longitude: 0, radius_meters: 150, max_allowed_accuracy_meters: 80}; startLocationWatch(); startLocationWatch();`, context);
  assert.equal(watches, 1);
  vm.runInContext('document.hidden = true; handleVisibilityChange();', context);
  assert.equal(clears, 1);
  vm.runInContext('document.hidden = false; startLocationWatch(); showLoginGate();', context);
  assert.equal(clears, 2);
  vm.runInContext('AppState.currentEmployee = {id: 1}; AppState.shiftStatus = "CLOCKED_OUT"; startLocationWatch();', context);
  assert.equal(watches, 2);
});
