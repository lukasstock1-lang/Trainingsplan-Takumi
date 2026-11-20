// Takumi 74 – Server (Cloudflare Worker)
//
// Liefert die App aus (statische Dateien) und stellt unter /api/ bereit:
// gemeinsame Daten (D1-Datenbank), Trainer-Login und Push-Nachrichten bei Absagen.
import { b64url, createVapidJwt, sendWebPush } from './webpush.js';

const PUSH_BATCH = 20; // Abos pro Worker-Aufruf (CPU-Limit im Gratis-Tarif)
const TOKEN_DAYS = 180;
const MAX_FAILED_LOGINS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const KEY_RE = /^([a-z0-9-]{1,60})@(\d{4}-\d{2}-\d{2})$/;
const PUSH_HOSTS = ['.googleapis.com', '.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];
const WD_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

const enc = new TextEncoder();
const dec = new TextDecoder();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const nowIso = () => new Date().toISOString();

function parseList(value) {
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function readBody(req) {
  try {
    return (await req.json()) || {};
  } catch {
    throw new HttpError(400, 'Ungültige Anfrage');
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Nicht gefunden', { status: 404 });
    }
    try {
      return await route(req, env, ctx, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Serverfehler – bitte später erneut versuchen.' }, 500);
    }
  },
};

async function route(req, env, ctx, url) {
  const path = url.pathname;
  const method = req.method;
  let m;

  // Öffentlich
  if (path === '/api/config' && method === 'GET') return json({ mode: 'server', vapidPublicKey: env.VAPID_PUBLIC_KEY || null });
  if (path === '/api/state' && method === 'GET') return json(await loadState(env));
  if (path === '/api/login' && method === 'POST') return login(req, env);
  if (path === '/api/push/subscribe' && method === 'POST') return subscribe(req, env);
  if (path === '/api/push/unsubscribe' && method === 'POST') return unsubscribe(req, env);
  if (path === '/api/push/test' && method === 'POST') return testPush(req, env, url);
  if (path === '/api/internal/push' && method === 'POST') return internalPush(req, env);

  // Ab hier nur mit Trainer-Anmeldung
  await requireTrainer(req, env);

  if (path === '/api/session' && method === 'GET') return json({ ok: true });
  if ((m = path.match(/^\/api\/occurrences\/([^/]+)\/cancel$/))) {
    const key = decodeURIComponent(m[1]);
    if (method === 'POST') return cancelTraining(req, env, ctx, url, key);
    if (method === 'DELETE') return reinstateTraining(env, key);
  }
  if ((m = path.match(/^\/api\/occurrences\/([^/]+)\/trainers$/))) {
    const key = decodeURIComponent(m[1]);
    if (method === 'PUT') return setTrainers(req, env, key);
    if (method === 'DELETE') return resetTrainers(env, key);
  }
  if (path === '/api/trainers' && method === 'POST') return addTrainer(req, env);
  if ((m = path.match(/^\/api\/trainers\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1]);
    if (method === 'PATCH') return renameTrainer(req, env, id);
    if (method === 'DELETE') return removeTrainer(env, id, url.searchParams.get('replacement'));
  }
  if (path === '/api/pin' && method === 'PUT') return changePin(req, env);

  throw new HttpError(404, 'Nicht gefunden');
}

// ---------------------------------------------------------------------------
// Daten lesen
// ---------------------------------------------------------------------------

const rowToSession = (r) => ({
  id: r.id,
  weekday: r.weekday,
  title: r.title,
  audience: r.audience,
  start: r.start_time,
  end: r.end_time,
  ...(r.time_text ? { timeText: r.time_text } : {}),
  location: r.location,
  trainerIds: parseList(r.trainer_ids),
});

async function loadState(env) {
  const [trainers, sessions, exceptions, events] = await env.DB.batch([
    env.DB.prepare('SELECT id, name FROM trainers ORDER BY sort, rowid'),
    env.DB.prepare('SELECT * FROM sessions ORDER BY sort, rowid'),
    env.DB.prepare('SELECT * FROM exceptions'),
    env.DB.prepare('SELECT id, type, key, reason, at, origin FROM events ORDER BY id DESC LIMIT 50'),
  ]);

  const exMap = {};
  for (const r of exceptions.results) {
    const ex = {};
    if (r.canceled) Object.assign(ex, { canceled: true, reason: r.reason || '', canceledAt: r.canceled_at });
    if (r.trainer_ids) ex.trainerIds = parseList(r.trainer_ids);
    exMap[r.key] = ex;
  }
  const ev = events.results.reverse();
  return {
    version: 1,
    trainers: trainers.results,
    sessions: sessions.results.map(rowToSession),
    exceptions: exMap,
    events: ev,
    lastEventId: ev.length ? ev[ev.length - 1].id : 0,
  };
}

async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

const setSetting = (env, key, value) =>
  env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2').bind(key, String(value));

// Prüft "sessionId@YYYY-MM-DD": Training existiert und das Datum passt zum Wochentag.
async function sessionForKey(env, key) {
  const m = KEY_RE.exec(key);
  if (!m) throw new HttpError(400, 'Ungültiger Termin');
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(m[1]).first();
  if (!row) throw new HttpError(404, 'Training nicht gefunden');
  const [y, mo, d] = m[2].split('-').map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  const weekday = date.getUTCDay() || 7;
  if (date.getUTCDate() !== d || weekday !== row.weekday) throw new HttpError(400, 'Datum passt nicht zum Training');
  return { session: rowToSession(row), date };
}

const cleanupException = (env, key) =>
  env.DB.prepare('DELETE FROM exceptions WHERE key = ? AND canceled = 0 AND trainer_ids IS NULL').bind(key);

// ---------------------------------------------------------------------------
// Trainer-Anmeldung
// ---------------------------------------------------------------------------

function requireSecret(env) {
  if (!env.AUTH_SECRET) throw new HttpError(500, 'Server ist noch nicht eingerichtet (AUTH_SECRET fehlt).');
}

async function hmac(env, data) {
  requireSecret(env);
  const key = await crypto.subtle.importKey('raw', enc.encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url.encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function makeToken(env, version) {
  const payload = b64url.encode(enc.encode(JSON.stringify({ v: version, exp: Date.now() + TOKEN_DAYS * 86400000 })));
  return `${payload}.${await hmac(env, payload)}`;
}

async function readToken(env, token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !safeEqual(await hmac(env, payload), sig)) return null;
  try {
    return JSON.parse(dec.decode(b64url.decode(payload)));
  } catch {
    return null;
  }
}

async function requireTrainer(req, env) {
  const header = req.headers.get('authorization') || '';
  const data = await readToken(env, header.startsWith('Bearer ') ? header.slice(7) : '');
  const version = Number((await getSetting(env, 'pin_version')) || 0);
  if (!data || data.v !== version || data.exp < Date.now()) {
    throw new HttpError(401, 'Bitte melde dich erneut als Trainer an.');
  }
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function pinMatches(env, pin) {
  const hash = await getSetting(env, 'pin_hash');
  if (hash) {
    const salt = await getSetting(env, 'pin_salt');
    return safeEqual(await sha256Hex(`${salt}:${pin}`), hash);
  }
  // Noch keine PIN gesetzt → Start-PIN aus dem Server-Geheimnis INITIAL_PIN
  return !!env.INITIAL_PIN && safeEqual(String(env.INITIAL_PIN), pin);
}

async function login(req, env) {
  requireSecret(env);
  const { pin } = await readBody(req);
  const ip = req.headers.get('cf-connecting-ip') || 'lokal';
  const now = Date.now();
  const row = await env.DB.prepare('SELECT window_start, count FROM login_attempts WHERE ip = ?').bind(ip).first();
  const inWindow = row && now - row.window_start < LOGIN_WINDOW_MS;
  if (inWindow && row.count >= MAX_FAILED_LOGINS) {
    throw new HttpError(429, 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut probieren.');
  }
  if (!(await pinMatches(env, String(pin ?? '')))) {
    await (inWindow
      ? env.DB.prepare('UPDATE login_attempts SET count = count + 1 WHERE ip = ?').bind(ip)
      : env.DB.prepare('INSERT OR REPLACE INTO login_attempts (ip, window_start, count) VALUES (?, ?, 1)').bind(ip, now)
    ).run();
    throw new HttpError(403, 'Falsche PIN');
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  const version = Number((await getSetting(env, 'pin_version')) || 0);
  return json({ token: await makeToken(env, version) });
}

async function changePin(req, env) {
  const { pin } = await readBody(req);
  if (!/^\d{4,8}$/.test(String(pin ?? ''))) throw new HttpError(400, 'Die PIN muss aus 4 bis 8 Ziffern bestehen.');
  const salt = b64url.encode(crypto.getRandomValues(new Uint8Array(16)));
  const version = Number((await getSetting(env, 'pin_version')) || 0) + 1;
  await env.DB.batch([
    setSetting(env, 'pin_salt', salt),
    setSetting(env, 'pin_hash', await sha256Hex(`${salt}:${pin}`)),
    setSetting(env, 'pin_version', version), // meldet alle anderen Geräte ab
  ]);
  return json({ token: await makeToken(env, version) });
}

// ---------------------------------------------------------------------------
// Trainings absagen & Trainer einteilen
// ---------------------------------------------------------------------------

function dateLabel(session, date) {
  const f = (d) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.`;
  if (!session.start && session.weekday >= 6) return `Wochenende ${f(date)} – ${f(new Date(date.getTime() + 86400000))}`;
  return `${WD_SHORT[date.getUTCDay()]}, ${f(date)}`;
}

const timeLabel = (s) => (s.start ? `${s.start} – ${s.end} Uhr` : s.timeText || 'Nach Vereinbarung');

async function cancelTraining(req, env, ctx, url, key) {
  const { session, date } = await sessionForKey(env, key);
  const body = await readBody(req);
  const reason = String(body.reason ?? '').trim().slice(0, 80);
  const origin = typeof body.origin === 'string' ? body.origin.slice(0, 20) : null;

  const existing = await env.DB.prepare('SELECT canceled FROM exceptions WHERE key = ?').bind(key).first();
  if (existing?.canceled) {
    // Schon abgesagt (z. B. doppelt getippt) → nur den Grund aktualisieren, keine zweite Push-Nachricht
    await env.DB.prepare('UPDATE exceptions SET reason = ? WHERE key = ?').bind(reason, key).run();
    return json(await loadState(env));
  }

  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO exceptions (key, canceled, reason, canceled_at) VALUES (?1, 1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET canceled = 1, reason = ?2, canceled_at = ?3`,
    ).bind(key, reason, at),
    env.DB.prepare('INSERT INTO events (type, key, reason, at, origin) VALUES (?, ?, ?, ?, ?)').bind('canceled', key, reason, at, origin),
  ]);

  const message = {
    title: '❌ Training fällt aus',
    body: `${session.title}\n${dateLabel(session, date)} · ${timeLabel(session)}${reason ? `\nGrund: ${reason}` : ''}`,
    tag: key,
    url: './',
  };
  // Push im Hintergrund verschicken – die Antwort an den Trainer kommt sofort.
  ctx.waitUntil(dispatchPush(env, message, session.title, url.origin));
  return json(await loadState(env));
}

async function reinstateTraining(env, key) {
  await sessionForKey(env, key);
  await env.DB.batch([
    env.DB.prepare('UPDATE exceptions SET canceled = 0, reason = NULL, canceled_at = NULL WHERE key = ?').bind(key),
    cleanupException(env, key),
  ]);
  return json(await loadState(env));
}

async function validTrainerIds(env, ids) {
  if (!Array.isArray(ids)) throw new HttpError(400, 'Ungültige Trainer');
  const unique = [...new Set(ids.filter((x) => typeof x === 'string'))];
  if (unique.length < 1 || unique.length > 3) throw new HttpError(400, 'Bitte 1 bis 3 Trainer wählen');
  const { results } = await env.DB.prepare('SELECT id FROM trainers').all();
  const known = new Set(results.map((r) => r.id));
  if (!unique.every((id) => known.has(id))) throw new HttpError(400, 'Unbekannter Trainer');
  return unique;
}

async function setTrainers(req, env, key) {
  const { session } = await sessionForKey(env, key);
  const { trainerIds, scope } = await readBody(req);
  const ids = await validTrainerIds(env, trainerIds);
  const list = JSON.stringify(ids);

  if (scope === 'weekly') {
    await env.DB.batch([
      env.DB.prepare('UPDATE sessions SET trainer_ids = ? WHERE id = ?').bind(list, session.id),
      env.DB.prepare('UPDATE exceptions SET trainer_ids = NULL WHERE key = ?').bind(key),
      cleanupException(env, key),
    ]);
  } else if (scope === 'once') {
    const sameAsDefault = list === JSON.stringify(session.trainerIds);
    await env.DB.batch(
      sameAsDefault
        ? [env.DB.prepare('UPDATE exceptions SET trainer_ids = NULL WHERE key = ?').bind(key), cleanupException(env, key)]
        : [
            env.DB.prepare(
              `INSERT INTO exceptions (key, canceled, trainer_ids) VALUES (?1, 0, ?2)
               ON CONFLICT(key) DO UPDATE SET trainer_ids = ?2`,
            ).bind(key, list),
          ],
    );
  } else {
    throw new HttpError(400, 'Ungültiger Geltungsbereich');
  }
  return json(await loadState(env));
}

async function resetTrainers(env, key) {
  await sessionForKey(env, key);
  await env.DB.batch([env.DB.prepare('UPDATE exceptions SET trainer_ids = NULL WHERE key = ?').bind(key), cleanupException(env, key)]);
  return json(await loadState(env));
}

// ---------------------------------------------------------------------------
// Trainer verwalten
// ---------------------------------------------------------------------------

function cleanName(name) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!n || n.length > 40) throw new HttpError(400, 'Bitte einen Namen mit höchstens 40 Zeichen eingeben.');
  return n;
}

function slug(name) {
  const base = name
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base || 'trainer'}-${b64url.encode(crypto.getRandomValues(new Uint8Array(3))).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
}

async function assertUniqueName(env, name, exceptId = null) {
  const row = await env.DB.prepare('SELECT id FROM trainers WHERE lower(name) = lower(?) AND id != ?').bind(name, exceptId || '').first();
  if (row) throw new HttpError(409, `${name} gibt es bereits.`);
}

async function addTrainer(req, env) {
  const name = cleanName((await readBody(req)).name);
  await assertUniqueName(env, name);
  const max = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM trainers').first();
  await env.DB.prepare('INSERT INTO trainers (id, name, sort) VALUES (?, ?, ?)').bind(slug(name), name, max.s + 1).run();
  return json(await loadState(env));
}

async function renameTrainer(req, env, id) {
  const name = cleanName((await readBody(req)).name);
  await assertUniqueName(env, name, id);
  const res = await env.DB.prepare('UPDATE trainers SET name = ? WHERE id = ?').bind(name, id).run();
  if (!res.meta.changes) throw new HttpError(404, 'Trainer nicht gefunden');
  return json(await loadState(env));
}

async function removeTrainer(env, id, replacementId) {
  const { results: trainers } = await env.DB.prepare('SELECT id FROM trainers').all();
  const ids = trainers.map((t) => t.id);
  if (!ids.includes(id)) throw new HttpError(404, 'Trainer nicht gefunden');
  if (ids.length <= 1) throw new HttpError(400, 'Mindestens ein Trainer muss bestehen bleiben.');
  const replacement = replacementId || null;
  if (replacement && (replacement === id || !ids.includes(replacement))) throw new HttpError(400, 'Ungültiger Nachfolger');

  const replace = (list) => [...new Set(list.flatMap((t) => (t === id ? (replacement ? [replacement] : []) : [t])))];
  const [{ results: sessions }, { results: exceptions }] = await env.DB.batch([
    env.DB.prepare('SELECT id, trainer_ids FROM sessions'),
    env.DB.prepare('SELECT key, trainer_ids FROM exceptions WHERE trainer_ids IS NOT NULL'),
  ]);
  const statements = [];
  for (const s of sessions) {
    const list = parseList(s.trainer_ids);
    if (list.includes(id)) statements.push(env.DB.prepare('UPDATE sessions SET trainer_ids = ? WHERE id = ?').bind(JSON.stringify(replace(list)), s.id));
  }
  for (const ex of exceptions) {
    const list = parseList(ex.trainer_ids);
    if (!list.includes(id)) continue;
    const next = replace(list);
    statements.push(
      env.DB.prepare('UPDATE exceptions SET trainer_ids = ? WHERE key = ?').bind(next.length ? JSON.stringify(next) : null, ex.key),
      cleanupException(env, ex.key),
    );
  }
  statements.push(env.DB.prepare('DELETE FROM trainers WHERE id = ?').bind(id));
  await env.DB.batch(statements);
  return json(await loadState(env));
}

// ---------------------------------------------------------------------------
// Push-Nachrichten
// ---------------------------------------------------------------------------

function validKey(value, length) {
  try {
    return typeof value === 'string' && value.length < 200 && b64url.decode(value).length === length;
  } catch {
    return false;
  }
}

function validEndpoint(endpoint, env) {
  try {
    if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
    const u = new URL(endpoint);
    if (env.ALLOW_ANY_PUSH_ENDPOINT === '1') return u.protocol === 'https:' || u.protocol === 'http:'; // nur für lokale Tests
    return u.protocol === 'https:' && PUSH_HOSTS.some((h) => u.hostname.endsWith(h));
  } catch {
    return false;
  }
}

async function subscribe(req, env) {
  const { subscription, groups } = await readBody(req);
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  if (!validEndpoint(endpoint, env) || !validKey(p256dh, 65) || !validKey(auth, 16)) {
    throw new HttpError(400, 'Ungültiges Push-Abo');
  }
  const list = Array.isArray(groups) ? groups.filter((g) => typeof g === 'string' && g.length <= 80).slice(0, 30) : [];
  const t = nowIso();
  await env.DB.prepare(
    `INSERT INTO subscriptions (endpoint, p256dh, auth, groups, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = ?2, auth = ?3, groups = ?4, updated_at = ?5`,
  )
    .bind(endpoint, p256dh, auth, JSON.stringify(list), t)
    .run();
  return json({ ok: true });
}

async function unsubscribe(req, env) {
  const { endpoint } = await readBody(req);
  if (typeof endpoint === 'string') await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(endpoint).run();
  return json({ ok: true });
}

// Test-Nachricht an genau ein Gerät (Knopf „Test senden“ in den Einstellungen).
async function testPush(req, env, url) {
  const { endpoint } = await readBody(req);
  const sub = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM subscriptions WHERE endpoint = ?').bind(String(endpoint ?? '')).first();
  if (!sub) throw new HttpError(404, 'Dieses Gerät ist nicht für Push angemeldet.');
  const message = { title: 'Takumi 74', body: '✅ Test erfolgreich – Push-Nachrichten kommen auf diesem Gerät an.', tag: 'test', url: './' };
  const result = await sendBatch(env, message, [sub], url.origin);
  if (!result.sent) throw new HttpError(502, 'Der Push-Dienst hat die Nachricht abgelehnt. Bitte Benachrichtigungen aus- und wieder einschalten.');
  return json({ ok: true });
}

// Verteilt die Nachricht an alle passenden Abos – in Paketen, jedes Paket
// in einem eigenen Worker-Aufruf (über die Service-Bindung SELF).
async function dispatchPush(env, message, groupTitle, subject) {
  const { results } = await env.DB.prepare('SELECT endpoint, p256dh, auth, groups FROM subscriptions').all();
  const targets = results
    .filter((r) => {
      const groups = parseList(r.groups);
      return groups.length === 0 || groups.includes(groupTitle);
    })
    .map(({ endpoint, p256dh, auth }) => ({ endpoint, p256dh, auth }));

  const jobs = [];
  for (let i = 0; i < targets.length; i += PUSH_BATCH) {
    const batch = targets.slice(i, i + PUSH_BATCH);
    jobs.push(
      env.SELF
        ? env.SELF.fetch('https://self/api/internal/push', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-internal-token': env.AUTH_SECRET },
            body: JSON.stringify({ message, targets: batch, subject }),
          })
        : sendBatch(env, message, batch, subject),
    );
  }
  const results2 = await Promise.allSettled(jobs);
  results2.filter((r) => r.status === 'rejected').forEach((r) => console.error('Push-Paket fehlgeschlagen', r.reason));
}

async function internalPush(req, env) {
  requireSecret(env);
  if (!safeEqual(req.headers.get('x-internal-token') || '', env.AUTH_SECRET)) throw new HttpError(403, 'Verboten');
  const { message, targets, subject } = await readBody(req);
  if (!Array.isArray(targets)) throw new HttpError(400, 'Ungültige Anfrage');
  return json(await sendBatch(env, message, targets.slice(0, PUSH_BATCH), subject));
}

async function sendBatch(env, message, targets, subject) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn('VAPID-Schlüssel fehlen – keine Push-Nachrichten');
    return { sent: 0, removed: 0 };
  }
  const vapid = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || subject,
  };
  // Ein VAPID-Token pro Push-Dienst (spart Rechenzeit)
  const jwtCache = new Map();
  for (const aud of new Set(targets.map((t) => new URL(t.endpoint).origin))) {
    jwtCache.set(aud, await createVapidJwt(aud, vapid));
  }
  const payload = JSON.stringify(message);
  const gone = [];
  let sent = 0;
  await Promise.all(
    targets.map(async (t) => {
      try {
        const status = await sendWebPush(t, payload, { vapid, jwtCache });
        if (status === 404 || status === 410) gone.push(t.endpoint);
        else if (status >= 400) console.warn('Push abgelehnt', status, new URL(t.endpoint).hostname);
        else sent++;
      } catch (e) {
        console.warn('Push-Fehler', e.message);
      }
    }),
  );
  if (gone.length) await env.DB.batch(gone.map((e) => env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(e)));
  return { sent, removed: gone.length };
}
