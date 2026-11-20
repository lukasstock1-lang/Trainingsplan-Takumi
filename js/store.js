// Datenhaltung der App.
//
// Demo-Modus: Alles liegt im localStorage des Browsers. Mehrere Tabs/Fenster
// desselben Browsers bleiben über das "storage"-Event synchron – so lässt sich
// "Trainer sagt ab → Eltern werden benachrichtigt" schon jetzt vorführen.
//
// Später: Die mit "SERVER:" markierten Stellen werden durch API-Aufrufe ersetzt
// (siehe README, Abschnitt "Nächste Schritte").
import { createDefaultState, STATE_VERSION } from './data.js';

const DATA_KEY = 'takumi74.data';
const DEVICE_KEY = 'takumi74.device';
const ROLE_KEY = 'takumi74.role';

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

function loadState() {
  const saved = read(local, DATA_KEY);
  return saved && saved.version === STATE_VERSION ? saved : createDefaultState();
}

const DEVICE_DEFAULTS = { groups: [], notify: false, seenEventId: 0, hideNotifyBanner: false };

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

let state = loadState();
let device = loadDevice();
const listeners = new Set();

function emit(meta = {}) {
  listeners.forEach((fn) => fn(meta));
}

function commit() {
  write(local, DATA_KEY, state); // SERVER: entfällt, der Server ist dann die Quelle der Wahrheit
  emit();
}

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

window.addEventListener('storage', (e) => {
  if (local && e.storageArea !== local) return;
  if (e.key === DATA_KEY || e.key === null) {
    state = loadState();
    emit({ external: true });
  } else if (e.key === DEVICE_KEY) {
    device = { ...loadDevice(), role: device.role };
    emit({ external: true });
  }
});

export const store = {
  get state() {
    return state;
  },
  get device() {
    return device;
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // ---------- Trainings ----------

  // SERVER: POST /api/occurrences/{key}/cancel { reason }
  // → Server speichert die Absage und verschickt Web-Push an alle Abonnenten.
  async cancelTraining(key, reason = '') {
    const ex = exceptionFor(key);
    ex.canceled = true;
    ex.reason = reason.trim();
    ex.canceledAt = new Date().toISOString();
    const event = { id: ++state.lastEventId, type: 'canceled', key, reason: ex.reason, at: ex.canceledAt, origin: TAB_ID };
    state.events = [...state.events, event].slice(-50);
    commit();
    return event;
  },

  // SERVER: DELETE /api/occurrences/{key}/cancel  (bewusst ohne Push)
  async reinstateTraining(key) {
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
  // SERVER: PUT /api/occurrences/{key}/trainers bzw. PUT /api/sessions/{id}/trainers
  async setTrainers(key, trainerIds, scope) {
    const ids = unique(trainerIds);
    const session = state.sessions.find((s) => s.id === key.split('@')[0]);
    if (!session) return;
    if (scope === 'weekly') {
      session.trainerIds = ids;
      if (state.exceptions[key]) delete state.exceptions[key].trainerIds;
    } else if (sameIds(ids, session.trainerIds)) {
      if (state.exceptions[key]) delete state.exceptions[key].trainerIds;
    } else {
      exceptionFor(key).trainerIds = ids;
    }
    dropEmptyException(key);
    commit();
  },

  async resetTrainers(key) {
    if (state.exceptions[key]) delete state.exceptions[key].trainerIds;
    dropEmptyException(key);
    commit();
  },

  // ---------- Trainer verwalten ----------

  // SERVER: POST /api/trainers { name }
  async addTrainer(name) {
    const trainer = { id: slug(name), name: name.trim() };
    state.trainers = [...state.trainers, trainer];
    commit();
    return trainer;
  },

  // SERVER: PATCH /api/trainers/{id} { name }
  async renameTrainer(id, name) {
    const t = state.trainers.find((x) => x.id === id);
    if (t) t.name = name.trim();
    commit();
  },

  // Entfernt einen Trainer; seine Trainings übernimmt optional ein Nachfolger.
  // SERVER: DELETE /api/trainers/{id}?replacement={id}
  async removeTrainer(id, replacementId = null) {
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

  // ---------- Zugang & Demo ----------

  // SERVER: Anmeldung läuft später über den Server (z. B. Trainer-Login), nicht über eine lokale PIN.
  checkPin(pin) {
    return String(pin) === String(state.pin);
  },

  async setPin(pin) {
    state.pin = String(pin);
    commit();
  },

  async resetDemo() {
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
