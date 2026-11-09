/**
 * Clockify — Offline Clock Queue (queue.js)
 *
 * IndexedDB-backed queue of clock intents. Every tap is persisted before any
 * network call, so a dropped connection can never lose the event. Each item
 * carries a stable intent_id used by the server as the idempotency key.
 */

(function (global) {
  "use strict";

  const DB_NAME = "clockify-offline";
  const DB_VERSION = 1;
  const STORE = "clock_intents";
  const RETAIN_MS = 24 * 60 * 60 * 1000; // keep resolved items for a day of UI history

  let dbPromise = null;

  function isSupported() {
    return typeof indexedDB !== "undefined";
  }

  function openDb() {
    if (!isSupported()) {
      return Promise.reject(new Error("Offline queue is not supported in this browser."));
    }
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "intent_id" });
          store.createIndex("employee_id", "employee_id", { unique: false });
          store.createIndex("status", "status", { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open the offline queue."));
    });

    return dbPromise;
  }

  function withStore(mode, operation) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let request;

      try {
        request = operation(store);
      } catch (err) {
        reject(err);
        return;
      }

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || tx.error);
      tx.onabort = () => reject(tx.error || new Error("Offline queue transaction aborted."));
    }));
  }

  function getAllItems() {
    return withStore("readonly", (store) => store.getAll()).then((items) => items || []);
  }

  const ClockQueue = {
    isSupported,

    init() {
      return openDb().then(() => ClockQueue.prune());
    },

    put(item) {
      return withStore("readwrite", (store) => store.put(item));
    },

    get(intentId) {
      return withStore("readonly", (store) => store.get(intentId));
    },

    remove(intentId) {
      return withStore("readwrite", (store) => store.delete(intentId));
    },

    all: getAllItems,

    pending() {
      return getAllItems().then((items) => items.filter((item) => item.status === "pending"));
    },

    pendingFor(employeeId, action) {
      return getAllItems().then((items) => items.find((item) =>
        item.employee_id === employeeId &&
        item.action === action &&
        item.status === "pending"
      ) || null);
    },

    update(intentId, patch) {
      return ClockQueue.get(intentId).then((existing) => {
        if (!existing) return null;
        const next = Object.assign({}, existing, patch);
        return ClockQueue.put(next).then(() => next);
      });
    },

    markAttempt(intentId, errorMessage) {
      return ClockQueue.get(intentId).then((existing) => {
        if (!existing) return null;
        return ClockQueue.update(intentId, {
          attempts: (existing.attempts || 0) + 1,
          error: errorMessage || null,
          last_attempt_at: new Date().toISOString()
        });
      });
    },

    confirm(intentId, record, duplicate) {
      return ClockQueue.get(intentId).then((existing) => {
        if (!existing) return null;
        const isClockIn = existing.action === "IN";
        const item = record || {};
        return ClockQueue.update(intentId, {
          status: "confirmed",
          attempts: (existing.attempts || 0) + 1,
          error: null,
          duplicate: Boolean(duplicate),
          record_id: item.id != null ? item.id : null,
          server_time: isClockIn ? item.clock_in_time || null : item.clock_out_time || null,
          server_received_at: isClockIn
            ? item.clock_in_received_at || null
            : item.clock_out_received_at || null,
          confirmed_at: new Date().toISOString()
        });
      });
    },

    reject(intentId, message) {
      return ClockQueue.update(intentId, {
        status: "rejected",
        error: message || "Rejected by the server.",
        rejected_at: new Date().toISOString()
      });
    },

    /** Drop resolved items older than the retention window. */
    prune() {
      const cutoff = Date.now() - RETAIN_MS;
      return getAllItems().then((items) => Promise.all(
        items
          .filter((item) => {
            if (item.status === "pending") return false;
            const stamp = item.confirmed_at || item.rejected_at || item.created_at;
            return stamp && new Date(stamp).getTime() < cutoff;
          })
          .map((item) => ClockQueue.remove(item.intent_id))
      ));
    }
  };

  global.ClockQueue = ClockQueue;
})(window);
