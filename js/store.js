// Datenhaltung der App – zwei Modi:
//
// • Server-Modus (Cloudflare): Die Daten liegen auf dem Server und gelten für alle.
//   Die App lädt sie beim Start, beim Zurückkehren in die App und jede Minute neu.
//   Eine Absage löst auf dem Server die Push-Nachrichten aus.
//
// • Demo-Modus (ohne Server, z. B. GitHub Pages oder lokal): Alles liegt im
//   localStorage des Browsers. Mehrere Tabs bleiben über das "storage"-Event synchron.
//
// Der Modus wird beim Start automatisch erkannt (siehe api.js).
import { createDefaultState, STATE_VERSION } from './data.js';
import { api, ApiError, detectMode, getToken, setToken } from './api.js';

const DATA_KEY = 'takumi74.data'; // Demo-Daten
const CACHE_KEY = 'takumi74.server-cache'; // zuletzt geladener Server-Stand
const DEVICE_KEY = 'takumi74.device';
const ROLE_KEY = 'takumi74.role';
const REFRESH_MS = 60000;

// Eindeutige Kennung dieses Tabs – damit der Absender einer Absage
// nicht zusätzlich die "eingehende" Meldung angezeigt bekommt.
export const TAB_ID = Math.random().toString(36).slice(2, 10);

function getStorage(name) {
  try {
    const s = window[name];
    s.setItem('__t', '1');
    s.removeItem('__t');
    return s;
  } catch {
    return null;
  }
}
const local = getStorage('localStorage');
const session = getStorage('sessionStorage');

function read(storage, key) {
  if (!storage) return null;
  try {
    return JSON.parse(storage.getItem(key));
  } catch {
    return null;
  }
}

function write(storage, key, value) {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* Speicher voll oder gesperrt – App läuft trotzdem weiter */
  }
}

const validState = (s) => s && s.version === STATE_VERSION && Array.isArray(s.sessions) && Array.isArray(s.trainers);

function loadLocalState() {
  const saved = read(local, DATA_KEY);
  return validState(saved) ? saved : createDefaultState();
}

const DEVICE_DEFAULTS = { groups: [], notify: false, seenEventId: 0, seenServerEventId: 0, hideNotifyBanner: false };

function loadDevice() {
  return {
    ...DEVICE_DEFAULTS,
    ...(read(local, DEVICE_KEY) || {}),
    // Die Rolle gilt pro Tab (sessionStorage), fällt aber auf die zuletzt
    // gewählte Rolle zurück – so können zur Vorführung zwei Fenster
    // gleichzeitig als "Trainer" und "Eltern" offen sein.
    role: read(session, ROLE_KEY) ?? read(local, ROLE_KEY) ?? null,
  };
}

let mode = local?.getItem('takumi74.mode') === 'server' ? 'server' : 'local'; // zuletzt erkannter Modus
let status = 'ok'; // 'ok' | 'offline'
let serverConfig = null;
let state = mode === 'server' && validState(read(local, CACHE_KEY)) ? read(local, CACHE_KEY) : loadLocalState();
let device = loadDevice();
const listeners = new Set();

function emit(meta = {}) {
  listeners.forEach((fn) => fn(meta));
}

const isServer = () => mode === 'server';

// Neuen Stand übernehmen (Server-Modus) bzw. speichern (Demo-Modus).
function commit(next, meta = {}) {
  if (next) state = next;
  write(local, isServer() ? CACHE_KEY : DATA_KEY, state);
  emit(meta);
}

// Ruft eine Trainer-Aktion auf dem Server auf. Bei abgelaufener Anmeldung
// wird zur Eltern-Ansicht gewechselt.
async function trainerCall(method, path, body) {
  try {
    return await api(method, path, body, { auth: true });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      setToken(null);
      store.setRole('member');
    }
    throw e;
  }
}

const occPath = (key, action) => `api/occurrences/${encodeURIComponent(key)}/${action}`;

// ---------- Demo-Modus: lokale Änderungen ----------

const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
const unique = (ids) => [...new Set(ids)];

function exceptionFor(key) {
  state.exceptions[key] ||= {};
  return state.exceptions[key];
}

function dropEmptyException(key) {
  const ex = state.exceptions[key];
  if (ex && !ex.canceled && !ex.trainerIds) delete state.exceptions[key];
}

function slug(name) {
  const base = name
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${base || 'trainer'}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------- Synchronisation ----------

window.addEventListener('storage', (e) => {
  if (local && e.storageArea !== local) return;
  if (!isServer() && (e.key === DATA_KEY || e.key === null)) {
    state = loadLocalState();
    emit({ external: true });
  } else if (isServer() && e.key === CACHE_KEY) {
    const cached = read(local, CACHE_KEY);
    if (validState(cached)) {
      state = cached;
      emit({ external: true });
    }
  } else if (e.key === DEVICE_KEY) {
    device = { ...loadDevice(), role: device.role };
    emit({ external: true });
  }
});

let refreshing = null;

async function refresh() {
  if (!isServer()) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const next = await api('GET', 'api/state');
      const changed = JSON.stringify(next) !== JSON.stringify(state);
      const wasOffline = status !== 'ok';
      status = 'ok';
      if (changed) commit(next, { external: true });
      else if (wasOffline) emit({ external: true });
    } catch {
      if (status !== 'offline') {
        status = 'offline';
        emit({ external: true });
      }
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function startSync() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  window.addEventListener('online', refresh);
  window.addEventListener('focus', refresh);
  // Der Service Worker meldet eingehende Push-Nachrichten → sofort neu laden.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'refresh') refresh();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, REFRESH_MS);
}

// ---------- Öffentliche Schnittstelle ----------

export const store = {
  get state() {
    return state;
  },
  get device() {
    return device;
  },
  get mode() {
    return mode;
  },
  get status() {
    return status;
  },
  get vapidPublicKey() {
    return serverConfig?.vapidPublicKey || null;
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // Erkennt den Modus und lädt im Server-Modus die aktuellen Daten.
  async init() {
    const detected = await detectMode();
    serverConfig = detected.config;
    if (detected.mode !== mode) {
      mode = detected.mode;
      const cached = read(local, CACHE_KEY);
      state = isServer() ? (validState(cached) ? cached : createDefaultState()) : loadLocalState();
    }
    if (isServer()) {
      if (!detected.online) status = 'offline';
      // Trainer-Rolle ohne gültige Server-Anmeldung (z. B. aus dem Demo-Modus) zurücksetzen
      if (device.role === 'trainer' && !getToken()) this.setRole('member');
      await refresh();
      startSync();
    }
    emit({ external: true });
  },

  refresh,

  // ---------- Trainings ----------

  async cancelTraining(key, reason = '') {
    if (isServer()) return commit(await trainerCall('POST', occPath(key, 'cancel'), { reason, origin: TAB_ID }));
    const ex = exceptionFor(key);
    ex.canceled = true;
    ex.reason = reason.trim();
    ex.canceledAt = new Date().toISOString();
    const event = { id: ++state.lastEventId, type: 'canceled', key, reason: ex.reason, at: ex.canceledAt, origin: TAB_ID };
    state.events = [...state.events, event].slice(-50);
    commit();
  },

  // Bewusst ohne Push-Nachricht.
  async reinstateTraining(key) {
    if (isServer()) return commit(await trainerCall('DELETE', occPath(key, 'cancel')));
    const ex = state.exceptions[key];
    if (ex) {
      delete ex.canceled;
      delete ex.reason;
      delete ex.canceledAt;
      dropEmptyException(key);
    }
    commit();
  },

  // scope "once" = nur dieser Termin (Vertretung), "weekly" = dauerhaft jede Woche.
  async setTrainers(key, trainerIds, scope) {
    const ids = unique(trainerIds);
    if (isServer()) return commit(await trainerCall('PUT', occPath(key, 'trainers'), { trainerIds: ids, scope }));
    const s = state.sessions.find((x) => x.id === key.split('@')[0]);
    if (!s) return;
    if (scope === 'weekly') {
      s.trainerIds = ids;
      if (state.exceptions[key]) delete state.exceptions[key].trainerIds;
    } else if (sameIds(ids, s.trainerIds)) {
      if (state.exceptions[key]) delete state.exceptions[key].trainerIds;
    } else {
      exceptionFor(key).trainerIds = ids;
    }
    dropEmptyException(key);
    commit();
  },

  async resetTrainers(key) {
    if (isServer()) return commit(await trainerCall('DELETE', occPath(key, 'trainers')));
    if (state.exceptions[key]) delete state.exceptions[key].trainerIds;
    dropEmptyException(key);
    commit();
  },

  // ---------- Trainer verwalten ----------

  async addTrainer(name) {
    if (isServer()) return commit(await trainerCall('POST', 'api/trainers', { name }));
    state.trainers = [...state.trainers, { id: slug(name), name: name.trim() }];
    commit();
  },

  async renameTrainer(id, name) {
    if (isServer()) return commit(await trainerCall('PATCH', `api/trainers/${encodeURIComponent(id)}`, { name }));
    const t = state.trainers.find((x) => x.id === id);
    if (t) t.name = name.trim();
    commit();
  },

  // Entfernt einen Trainer; seine Trainings übernimmt optional ein Nachfolger.
  async removeTrainer(id, replacementId = null) {
    if (isServer()) {
      const q = replacementId ? `?replacement=${encodeURIComponent(replacementId)}` : '';
      return commit(await trainerCall('DELETE', `api/trainers/${encodeURIComponent(id)}${q}`));
    }
    const replace = (ids) => unique(ids.flatMap((t) => (t === id ? (replacementId ? [replacementId] : []) : [t])));
    state.sessions.forEach((s) => {
      s.trainerIds = replace(s.trainerIds);
    });
    Object.values(state.exceptions).forEach((ex) => {
      if (ex.trainerIds) ex.trainerIds = replace(ex.trainerIds);
    });
    state.trainers = state.trainers.filter((t) => t.id !== id);
    commit();
  },

  assignmentCount(id) {
    return state.sessions.filter((s) => s.trainerIds.includes(id)).length;
  },

  // ---------- Zugang ----------

  // true = angemeldet, false = falsche PIN; andere Fehler werden geworfen.
  async login(pin) {
    if (isServer()) {
      try {
        const { token } = await api('POST', 'api/login', { pin: String(pin) });
        setToken(token);
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) return false;
        throw e;
      }
    } else if (String(pin) !== String(state.pin)) {
      return false;
    }
    this.setRole('trainer');
    return true;
  },

  logout() {
    setToken(null);
    this.setRole(null);
  },

  async setPin(pin) {
    if (isServer()) {
      const { token } = await trainerCall('PUT', 'api/pin', { pin: String(pin) });
      setToken(token);
      return;
    }
    state.pin = String(pin);
    commit();
  },

  // Nur im Demo-Modus
  async resetDemo() {
    if (isServer()) return;
    const lastEventId = state.lastEventId; // Ereignis-Nummern laufen weiter, damit andere Tabs nichts verpassen
    state = { ...createDefaultState(), lastEventId };
    commit();
  },

  // ---------- Geräte-Einstellungen (nur dieses Gerät) ----------

  setDevice(patch, { silent = false } = {}) {
    device = { ...device, ...patch };
    const { role, ...rest } = device;
    write(local, DEVICE_KEY, rest);
    if (!silent) emit();
  },

  setRole(role) {
    device = { ...device, role };
    write(session, ROLE_KEY, role);
    write(local, ROLE_KEY, role);
    emit();
  },
};
