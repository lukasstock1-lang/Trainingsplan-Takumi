// Richtet die Datenbank beim ersten Aufruf selbst ein (Tabellen, Startdaten,
// Schlüssel) – so ist auf Cloudflare nur die Trainer-PIN von Hand zu setzen.
import { DEFAULT_SESSIONS, DEFAULT_TRAINERS } from '../../js/data.js';
import { b64url } from './webpush.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trainers (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0)`,
  // Wöchentlich wiederkehrende Trainings (weekday: 1 = Montag … 7 = Sonntag)
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY, weekday INTEGER NOT NULL, title TEXT NOT NULL, audience TEXT NOT NULL,
     start_time TEXT, end_time TEXT, time_text TEXT, location_id TEXT NOT NULL,
     trainer_ids TEXT NOT NULL DEFAULT '[]', sort INTEGER NOT NULL DEFAULT 0)`,
  // Ausnahmen für einen Termin "<sessionId>@<YYYY-MM-DD>": Absage, Vertretung, anderer Ort
  `CREATE TABLE IF NOT EXISTS exceptions (
     key TEXT PRIMARY KEY, canceled INTEGER NOT NULL DEFAULT 0, reason TEXT, canceled_at TEXT,
     trainer_ids TEXT, location_id TEXT)`,
  // Protokoll der Absagen (daraus entstehen die Hinweise in der App)
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, key TEXT NOT NULL,
     reason TEXT, at TEXT NOT NULL, origin TEXT)`,
  // Geräte, die Push-Nachrichten bekommen
  `CREATE TABLE IF NOT EXISTS subscriptions (
     endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
     groups TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  // Freiwillige Zu-/Absagen (sehen nur die Trainer)
  `CREATE TABLE IF NOT EXISTS rsvps (
     key TEXT NOT NULL, device_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
     updated_at TEXT NOT NULL, PRIMARY KEY (key, device_id))`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
     ip TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)`,
];

async function createSchemaAndSeed(db) {
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));

  // Neue Trainings aus dem Plan werden ergänzt, bestehende bleiben unverändert.
  const sessionInserts = DEFAULT_SESSIONS.map((s, i) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, weekday, title, audience, start_time, end_time, time_text, location_id, trainer_ids, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(s.id, s.weekday, s.title, s.audience, s.start, s.end, s.timeText || null, s.locationId, JSON.stringify(s.trainerIds), i),
  );
  // Trainer nur beim allerersten Start anlegen (gelöschte sollen nicht zurückkommen).
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM trainers').first();
  const trainerInserts = n
    ? []
    : DEFAULT_TRAINERS.map((t, i) => db.prepare('INSERT OR IGNORE INTO trainers (id, name, sort) VALUES (?, ?, ?)').bind(t.id, t.name, i));
  await db.batch([...trainerInserts, ...sessionInserts]);
}

async function generateKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    auth_secret: b64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    vapid_public: b64url.encode(publicRaw),
    vapid_private: jwk.d,
  };
}

async function loadKeys(db) {
  const read = async () => {
    const { results } = await db
      .prepare("SELECT key, value FROM settings WHERE key IN ('auth_secret', 'vapid_public', 'vapid_private')")
      .all();
    return Object.fromEntries(results.map((r) => [r.key, r.value]));
  };
  let keys = await read();
  if (!keys.auth_secret || !keys.vapid_public || !keys.vapid_private) {
    const fresh = await generateKeys();
    // OR IGNORE: Starten zwei Aufrufe gleichzeitig, gewinnt der erste.
    await db.batch(
      Object.entries(fresh).map(([k, v]) => db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind(k, v)),
    );
    keys = await read();
  }
  return keys;
}

let initPromise = null;

// Einmal pro Worker-Instanz: Schema, Startdaten und Schlüssel sicherstellen.
// Geheimnisse aus Cloudflare (falls gesetzt) haben Vorrang vor den gespeicherten.
export function ensureSetup(env) {
  if (!env.DB) return Promise.reject(Object.assign(new Error('DB fehlt'), { code: 'NO_DB' }));
  initPromise ||= (async () => {
    await createSchemaAndSeed(env.DB);
    const keys = await loadKeys(env.DB);
    return {
      authSecret: env.AUTH_SECRET || keys.auth_secret,
      vapidPublic: env.VAPID_PUBLIC_KEY || keys.vapid_public,
      vapidPrivate: env.VAPID_PRIVATE_KEY || keys.vapid_private,
    };
  })().catch((e) => {
    initPromise = null;
    throw e;
  });
  return initPromise;
}
