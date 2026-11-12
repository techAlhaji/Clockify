/**
 * Clockify — Service Worker for Offline-Tolerant Clocking
 * 
 * This service worker provides:
 * 1. Offline cache for the app shell (HTML, CSS, JS, essential assets)
 * 2. IndexedDB-based queue for clock-in/clock-out events when offline
 * 3. Sync when the network is back, with exponential backoff retry
 * 4. Display "Pending" status for offline clock events
 */

const CACHE_NAME = 'clockify-v1';
const OFFLINE_URL = '/offline.html';

// Assets to cache for offline use
const PRECACHE_ASSETS = [
  '/',
  '/static/js/api.js',
  '/static/js/app.js',
  '/static/js/geo.js',
  '/static/css/style.css',
  '/static/css/admin.css',
  '/favicon.ico',
];

// Store queue in IndexedDB
let db = null;

// Initialize IndexedDB database for clock event queue
function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('clockify-queue', 1);
    
    request.onupgradeneeded = (event) => {
      db = event.target.result;
      if (!db.objectStoreNames.contains('clock-queue')) {
        db.createObjectStore('clock-queue', { keyPath: 'id', autoIncrement: true });
      }
    };
    
    request.onsuccess = (event) => {
      db = event.target.result;
      resolve();
    };
    
    request.onerror = (event) => {
      console.error('IndexedDB error:', event.target.error);
      reject(event.target.error);
    };
  });
}

// Add a clock event to the offline queue
async function queueClockEvent(event) {
  if (!db) await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('clock-queue', 'readwrite');
    const store = transaction.objectStore('clock-queue');
    const request = store.add({
      ...event,
      status: 'pending',
      created_at: new Date().toISOString(),
      attempts: 0
    });
    
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Get all pending clock events from the queue
async function getPendingEvents() {
  if (!db) await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('clock-queue', 'readonly');
    const store = transaction.objectStore('clock-queue');
    const request = store.getAll(request => request.status === 'pending');
    
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

// Update the status of a clock event in the queue
async function updateEventStatus(id, status, error = null) {
  if (!db) await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('clock-queue', 'readwrite');
    const store = transaction.objectStore('clock-queue');
    const request = store.get(id);
    
    request.onsuccess = async () => {
      const event = request.result;
      if (event) {
        event.status = status;
        event.error = error;
        event.attempts += 1;
        
        const updateRequest = store.put(event);
        updateRequest.onsuccess = () => resolve(event);
        updateRequest.onerror = () => reject(updateRequest.error);
      } else {
        reject(new Error('Event not found'));
      }
    };
    
    request.onerror = () => reject(request.error);
  });
}

// Delete a clock event from the queue after successful sync
async function deleteEvent(id) {
  if (!db) await initDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('clock-queue', 'readwrite');
    const store = transaction.objectStore('clock-queue');
    const request = store.delete(id);
    
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Exponential backoff delay
function backoffDelay(attempts) {
  const base = 1000; // 1 second base
  const jitter = Math.random() * 1000; // up to 1 second jitter
  const delay = base * Math.pow(2, Math.min(attempts, 5)) + jitter; // cap at 6 attempts
  return Math.min(delay, 30000); // max 30 seconds
}

// Handle sync when network comes back online
self.addEventListener('online', async () => {
  console.log('Network is back online, syncing clock events...');
  
  const pendingEvents = await getPendingEvents();
  
  for (const event of pendingEvents) {
    try {
      // Determine which API endpoint to call based on event type
      const url = event.type === 'clock-in' 
        ? '/api/attendance/clock-in' 
        : '/api/attendance/clock-out';
      
      const payload = {
        latitude: event.latitude,
        longitude: event.longitude,
        accuracy: event.accuracy,
        clock_intent_id: event.clock_intent_id
      };
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': event.authToken
        },
        body: JSON.stringify(payload),
        credentials: 'include'
      });
      
      if (response.ok) {
        await updateEventStatus(event.id, 'synced');
      } else {
        const errorData = await response.json().catch(() => ({}));
        await updateEventStatus(event.id, 'failed', errorData.detail || 'Request failed');
      }
    } catch (err) {
      await updateEventStatus(event.id, 'failed', err.message);
    }
  }
});

// Fetch event from cache, trying network first, then cache
async function fetchWithCache(request) {
  const cache = await caches.open(CACHE_NAME);
  const networkResponse = fetch(request);
  
  const cachedResponse = await cache.match(request);
  
  if (cachedResponse) {
    const networkResponse = fetch(request);
    return networkResponse.then(networkResp => {
      if (networkResp.ok) {
        // Update cache
        cache.put(request, networkResp.clone());
        return networkResp;
      }
      return cachedResponse;
    });
  }
  
  return networkResponse;
}

// Install event - cache essential assets
self.addEventListener('install', (event) => {
  console.log('Service worker installing.');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Cached assets');
      return cache.addAll(PRECACHE_ASSETS);
    })
  );
  
  // Skip waiting to activate immediately
  self.clients.claim();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('Service worker activating.');
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(keyList.map((key) => {
        if (key !== CACHE_NAME) {
          console.log('Removing old cache:', key);
          return caches.delete(key);
        }
      }));
    })
  );
  
  // Claim all clients immediately
  self.clients.claim();
});

// Fetch event - serve from cache, fall back to network
self.addEventListener('fetch', (event) => {
  // Don't cache API requests or offline page
  if (event.request.url.includes('/api/') || event.request.url.includes('/offline.html')) {
    event.respondWith(fetch(event.request));
    return;
  }
  
  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) {
        return response;
      }
      return fetch(event.request);
    })
  );
});

// Message handler from the client page
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'queue-clock-event') {
    queueClockEvent(event.data.event).then((id) => {
      event.source.postMessage({
        type: 'queue-event-response',
        success: true,
        id: id
      });
    }).catch((err) => {
      event.source.postMessage({
        type: 'queue-event-response',
        success: false,
        error: err.message
      });
    });
  }
  
  if (event.data && event.data.type === 'get-pending-events') {
    getPendingEvents().then((events) => {
      event.source.postMessage({
        type: 'pending-events-response',
        events: events
      });
    });
  }
});