const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Geo = require('../frontend/js/geo.js');

function harness() {
  const nodes = new Map(), watches = new Map(), timers = new Map(), requests = [], events = [];
  let nextId = 0, now = 100000;
  const listeners = {};
  const getNode = id => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, className: '', textContent: '', innerHTML: '',
      classList: { add() {}, remove() {} }, addEventListener(type, fn) { listeners[id + ':' + type] = fn; } });
    return nodes.get(id);
  };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    Date: Clock, console, escapeHtml: String,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    document: { hidden: false, getElementById: getNode, addEventListener(type, fn) { listeners[type] = fn; } },
    window: { addEventListener(type, fn) { listeners[type] = fn; }, dispatchEvent(event) { events.push(event); } },
    setInterval(fn) { const id = nextId++; timers.set(id, fn); return id; },
    clearInterval(id) { timers.delete(id); },
    localStorage: { getItem() { return null; }, removeItem() {}, setItem() {} },
    ApiClient: { clearEmployeeToken() {} },
    GeoService: { verifyGeofence: Geo.verifyGeofence.bind(Geo),
      watchDistanceToOffice(lat, lon, radius, callback, options) { const id = nextId++; watches.set(id, { callback, options }); return id; },
      clearWatch(id) { watches.delete(id); },
      getCurrentPosition() { return new Promise((resolve, reject) => requests.push({ resolve, reject })); } }
  });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync(require('node:path').resolve(__dirname, '../frontend/js/app.js'), 'utf8'));
  run('AppState.currentEmployee = {id: 1}; AppState.workplace = {name: "Office", latitude: 0, longitude: 0, radius_meters: 150, max_allowed_accuracy_meters: 80};');
  const fix = (meters = 24, accuracy = 10) => ({ latitude: meters / 6371000 * 180 / Math.PI, longitude: 0, accuracy, timestamp: now });
  return { run, context, watches, timers, requests, events, listeners, getNode, fix,
    advance(ms) { now += ms; }, sample(value = fix()) { [...watches.values()][0].callback(value); },
    snapshot() { return context.window.ClockifyLocation.getSnapshot(); } };
}

test('radar exposes immutable fixes, accurate copy and time-based freshness', () => {
  const h = harness(); h.run('startLocationWatch()'); h.sample();
  assert.equal(h.snapshot().sample.distance, 24);
  assert.equal(h.snapshot().sample.effectiveDistance, 34);
  assert.equal(h.snapshot().verifiedPresence, true);
  assert.equal(Object.isFrozen(h.snapshot().sample), true);
  assert.match(h.getNode('distanceValue').textContent, /You are 24 m from the office — inside the 150 m boundary/);
  assert.match(h.getNode('distanceSub').textContent, /GPS accuracy ±10 m.*Effective \(worst-case\) distance 34 m/);
  assert.equal(h.events.at(-1).type, 'clockify:location-update');
  h.advance(90000); [...h.timers.values()].forEach(fn => fn());
  assert.equal(h.snapshot().fresh, false);
  assert.equal(h.snapshot().verifiedPresence, false);
  assert.match(h.getNode('statusBadge').innerHTML, /GPS Stale/);
  assert.equal(h.getNode('radarDot').className, 'radar-user');
});

test('permission denied then Retry recovers without reload or duplicate watcher', async () => {
  const h = harness(); h.run('startLocationWatch()');
  const old = [...h.watches.values()][0].callback;
  h.sample({ error: 'Permission denied', code: 1 });
  assert.equal(h.watches.size, 0); assert.equal(h.timers.size, 0);
  assert.equal(h.snapshot().state, 'denied');
  const retry = h.run('refreshLocation()');
  assert.equal(h.getNode('btnRefreshLocation').disabled, true);
  h.requests.at(-1).resolve(h.fix()); await retry;
  assert.equal(h.snapshot().state, 'live'); assert.equal(h.watches.size, 1);
  assert.equal(h.getNode('btnRefreshLocation').disabled, false);
  old(h.fix(100)); assert.equal(h.snapshot().sample.distance, 24);
  h.run('startLocationWatch(); startLocationWatch()'); assert.equal(h.watches.size, 1);
});

for (const code of [2, 3]) test(`transient GPS error ${code} retains a stale fix and recovers`, async () => {
  const h = harness(); h.run('startLocationWatch()'); h.sample();
  h.sample({ error: code === 2 ? 'GPS unavailable' : 'GPS timed out', code });
  assert.equal(h.snapshot().fresh, false); assert.equal(h.snapshot().sample.distance, 24);
  assert.equal(h.getNode('radarDot').className, 'radar-user');
  const retry = h.run('refreshLocation()'); h.requests.at(-1).reject(new Error('Still unavailable')); await retry;
  assert.equal(h.watches.size, 1); assert.equal(h.snapshot().state, 'stale');
  h.sample(h.fix(100)); assert.equal(h.snapshot().fresh, true); assert.equal(h.snapshot().sample.distance, 100);
});

test('hide/show cancels retry, restarts promptly and ignores old request results', async () => {
  const h = harness(); h.run('startLocationWatch()');
  const oldRetry = h.run('refreshLocation()'); const oldRequest = h.requests.at(-1);
  h.run('document.hidden = true; handleVisibilityChange()');
  assert.equal(h.watches.size, 0); assert.equal(h.timers.size, 0);
  h.run('document.hidden = false');
  const newRetry = h.run('refreshLocation()');
  oldRequest.resolve(h.fix(100)); await oldRetry;
  assert.equal(h.snapshot().sample, null);
  assert.equal(h.getNode('btnRefreshLocation').disabled, true);
  h.requests.at(-1).resolve(h.fix()); await newRetry;
  assert.equal(h.watches.size, 1); assert.equal(h.timers.size, 1);
});

test('logout clears sample and ignores watcher and one-shot callbacks', async () => {
  const h = harness(); h.run('startLocationWatch()'); h.sample();
  const oldWatch = [...h.watches.values()][0].callback;
  const pending = h.run('refreshLocation()');
  h.run('showLoginGate()');
  h.requests.at(-1).resolve(h.fix()); await pending; oldWatch(h.fix());
  assert.equal(h.snapshot().sample, null); assert.equal(h.snapshot().state, 'signedOut');
  assert.equal(h.watches.size, 0); assert.equal(h.timers.size, 0);
  assert.equal(h.events.at(-1).detail.sample, null);
});

test('completed shift cannot restart tracking through retry, focus or visibility', async () => {
  const h = harness(); h.run('startLocationWatch()'); h.sample();
  h.run('AppState.shiftStatus = "CLOCKED_OUT"; stopLocationWatch("complete"); handleWindowFocus(); handleVisibilityChange(); startLocationWatch()');
  await h.run('refreshLocation()');
  assert.equal(h.watches.size, 0); assert.equal(h.timers.size, 0);
  assert.equal(h.requests.length, 0); assert.equal(h.snapshot().verifiedPresence, false);
  assert.equal(h.getNode('btnRefreshLocation').disabled, true);
});

test('poor accuracy never reports presence and 100 meter movement updates radar', () => {
  const h = harness(); h.run('startLocationWatch()'); h.sample(h.fix(24, 81));
  assert.equal(h.snapshot().verifiedPresence, false);
  assert.match(h.getNode('distanceValue').textContent, /unable to verify/);
  h.sample(h.fix(124)); assert.equal(h.snapshot().sample.distance, 124);
  h.sample(h.fix(145)); assert.equal(h.snapshot().sample.isInside, false);
  assert.match(h.getNode('distanceValue').textContent, /outside the 150 m boundary/);
});

test('clock verification pending at logout cannot submit the old fix', async () => {
  const h = harness();
  const request = h.run('getFreshClockLocation()');
  const rejected = assert.rejects(request, error => error.cancelled === true);
  h.run('showLoginGate()'); h.requests.at(-1).resolve(h.fix()); await rejected;
  assert.equal(h.snapshot().sample, null); assert.equal(h.watches.size, 0);
});

test('successful clock-out stops tracking immediately', async () => {
  const h = harness(); h.run('showToast = () => {}; refreshShiftData = async () => {}; AppState.shiftStatus = "CLOCKED_IN"; ApiClient.clockOut = async () => ({record: {clock_out_time: "17:00"}}); startLocationWatch()');
  const clockOut = h.run('handleClockOut()');
  h.requests.at(-1).resolve(h.fix()); await clockOut;
  assert.equal(h.snapshot().state, 'complete');
  assert.equal(h.watches.size, 0); assert.equal(h.timers.size, 0);
});

test('session expiry removes location and invalidates callbacks', () => {
  const h = harness(); h.run('showToast = () => {}; startLocationWatch()'); h.sample();
  const old = [...h.watches.values()][0].callback;
  h.run('handleSessionExpired()'); old(h.fix(100));
  assert.equal(h.snapshot().sample, null); assert.equal(h.snapshot().state, 'signedOut');
  assert.equal(h.watches.size, 0); assert.equal(h.timers.size, 0);
});
