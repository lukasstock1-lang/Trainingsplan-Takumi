// Server-Test: startet den Worker lokal (eigene, leere Test-Datenbank), simuliert
// einen Push-Dienst und prüft Einrichtung, API, Trainer-Login, Orte, Zu-/Absagen
// und Push-Nachrichten Ende-zu-Ende.
// Aufruf: npm test
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

const PORT = 8799;
const PUSH_PORT = 9911;
const BASE = `http://127.0.0.1:${PORT}`;
const PIN = '4711';
const persist = mkdtempSync(join(tmpdir(), 'takumi74-test-'));
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// --- Simulierter Push-Dienst ---
const received = [];
const pushServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(req.url.includes('gone') ? 410 : 201).end();
  });
});

// Ein "Gerät" mit eigenem Schlüsselpaar (wie ein Browser bei pushManager.subscribe)
function makeDevice(name) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: {
      endpoint: `http://127.0.0.1:${PUSH_PORT}/push/${name}`,
      keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) },
    },
  };
}

// Unabhängige Entschlüsselung nach RFC 8291 mit node:crypto
function decrypt(device, body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdhSecret = device.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), device.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, device.auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2, 'Padding-Trennzeichen 0x02');
  return JSON.parse(plain.subarray(0, -1).toString());
}

function verifyVapid(header, audience, vapidPublic) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, 'Authorization-Header im VAPID-Format');
  assert.equal(m[2], vapidPublic, 'öffentlicher Schlüssel stimmt');
  const raw = Buffer.from(vapidPublic, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
  const [h, c, s] = m[1].split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'VAPID-Signatur gültig');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.aud, audience);
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600, 'exp höchstens 24 h');
  assert.ok(claims.sub, 'sub gesetzt');
}

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// Datum des Wochentags in der nächsten Woche (1 = Mo … 7 = So)
const nextWeekday = (weekday, weeksAhead = 1) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((weekday - (d.getUTCDay() || 7) + 7) % 7) + 7 * weeksAhead);
  return d.toISOString().slice(0, 10);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
};

let worker;
let vapidPublic;
let token;

before(async () => {
  await new Promise((r) => pushServer.listen(PUSH_PORT, '127.0.0.1', r));
  // Keine Migrationen: der Worker richtet die leere Datenbank selbst ein.
  const args = ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist, '--env-file', '/dev/null', '--test-scheduled'];
  for (const [k, v] of Object.entries({ TRAINER_PIN: PIN, ALLOW_ANY_PUSH_ENDPOINT: '1' })) args.push('--var', `${k}:${v}`);
  worker = spawn('npx', args, { stdio: 'ignore', env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      ready = (await fetch(`${BASE}/api/health`)).ok;
    } catch {
      await sleep(500);
    }
  }
  assert.ok(ready, 'Worker gestartet');
});

after(() => {
  worker?.kill();
  pushServer.close();
  rmSync(persist, { recursive: true, force: true });
});

test('richtet sich selbst ein (Schema, Startdaten, Schlüssel)', async () => {
  const health = await api('GET', '/api/health');
  assert.deepEqual(
    { db: health.data.datenbank, push: health.data.push, pin: health.data.trainerPin, ok: health.data.allesBereit },
    { db: 'ok', push: 'ok', pin: 'ok', ok: true },
  );
  const cfg = await api('GET', '/api/config');
  assert.equal(cfg.data.mode, 'server');
  assert.equal(cfg.data.ready, true);
  vapidPublic = cfg.data.vapidPublicKey;
  assert.equal(Buffer.from(vapidPublic, 'base64url').length, 65);
  assert.equal((await api('GET', '/api/config')).data.vapidPublicKey, vapidPublic, 'Schlüssel bleibt gleich');

  const { data } = await api('GET', '/api/state');
  assert.equal(data.trainers.length, 5);
  assert.equal(data.sessions.length, 11);
  const di = data.sessions.find((s) => s.id === 'di-erwachsene');
  assert.deepEqual(
    { wd: di.weekday, t: di.title, s: di.start, e: di.end, tr: di.trainerIds, loc: di.locationId },
    { wd: 2, t: 'Erwachsenentraining', s: '18:00', e: '19:15', tr: ['ruwantha-de-silva'], loc: 'erlenbach-halle' },
  );
  assert.deepEqual(data.locations.map((l) => l.id), ['erlenbach-halle', 'erlenbach-talstrasse', 'ilvesheim-neckarstadion']);
  assert.equal(data.sessions.find((s) => s.id === 'mi-athletik').locationId, 'erlenbach-talstrasse');
});

test('Trainer-Aktionen ohne Anmeldung sind gesperrt', async () => {
  const key = `mo-shoshin@${nextWeekday(1)}`;
  assert.equal((await api('POST', `/api/occurrences/${key}/cancel`, {})).status, 401);
  assert.equal((await api('GET', '/api/rsvps')).status, 401, 'Rückmeldungen nur für Trainer');
  assert.equal((await api('PUT', `/api/occurrences/${key}/location`, { locationId: 'ilvesheim-neckarstadion' })).status, 401);
  assert.equal((await api('POST', '/api/trainers', { name: 'X' }, 'gefälscht.token')).status, 401);
  assert.equal((await api('POST', '/api/internal/push', { targets: [] })).status, 403);
});

test('Login und Absage mit Push an die passenden Geräte', async () => {
  assert.equal((await api('POST', '/api/login', { pin: '0000' })).status, 403);
  const login = await api('POST', '/api/login', { pin: PIN });
  assert.equal(login.status, 200);
  token = login.data.token;

  const all = makeDevice('all');
  const athletik = makeDevice('athletik');
  const gone = makeDevice('gone');
  assert.equal((await api('POST', '/api/push/subscribe', { subscription: all.subscription, groups: [] })).status, 200);
  assert.equal((await api('POST', '/api/push/subscribe', { subscription: athletik.subscription, groups: ['Takumi Athletikgruppe'] })).status, 200);
  assert.equal((await api('POST', '/api/push/subscribe', { subscription: gone.subscription, groups: [] })).status, 200);
  assert.equal((await api('POST', '/api/push/subscribe', { subscription: { endpoint: 'x', keys: {} } })).status, 400);

  // Test-Push an genau ein Gerät
  assert.equal((await api('POST', '/api/push/test', { endpoint: athletik.subscription.endpoint })).status, 200);
  assert.ok(await waitFor(() => received.length === 1));
  assert.match(decrypt(athletik, received[0].body).body, /Test erfolgreich/);
  received.length = 0;

  assert.equal((await api('POST', `/api/occurrences/mo-shoshin@${nextWeekday(2)}/cancel`, {}, token)).status, 400, 'Datum passt nicht');

  const key = `mo-shoshin@${nextWeekday(1)}`;
  const res = await api('POST', `/api/occurrences/${key}/cancel`, { reason: 'Halle gesperrt', origin: 'tab1' }, token);
  assert.equal(res.status, 200);
  assert.equal(res.data.exceptions[key].canceled, true);
  assert.equal(res.data.events.at(-1).origin, 'tab1');

  assert.ok(await waitFor(() => received.length >= 2), `Push angekommen (${received.length})`);
  await sleep(500);
  assert.deepEqual(received.map((r) => r.path).sort(), ['/push/all', '/push/gone'], 'nur passende Gruppen');
  const msg = received.find((r) => r.path === '/push/all');
  assert.equal(msg.headers['content-encoding'], 'aes128gcm');
  verifyVapid(msg.headers.authorization, `http://127.0.0.1:${PUSH_PORT}`, vapidPublic);
  const payload = decrypt(all, msg.body);
  assert.equal(payload.title, '❌ Training fällt aus');
  assert.match(payload.body, /Takumi Shoshin Gruppe\nMo, \d\d\.\d\d\. · 16:30 – 18:00 Uhr\nGrund: Halle gesperrt/);

  // Abgelaufenes Gerät (410) wurde entfernt; doppelte Absage → keine zweite Nachricht
  received.length = 0;
  const key2 = `mi-athletik@${nextWeekday(3)}`;
  await api('POST', `/api/occurrences/${key2}/cancel`, {}, token);
  assert.ok(await waitFor(() => received.length >= 2));
  await sleep(500);
  assert.deepEqual(received.map((r) => r.path).sort(), ['/push/all', '/push/athletik']);
  received.length = 0;
  await api('POST', `/api/occurrences/${key2}/cancel`, { reason: 'Krankheit' }, token);
  await api('DELETE', `/api/occurrences/${key}/cancel`, null, token);
  await sleep(1000);
  assert.equal(received.length, 0, 'keine Push bei doppelter Absage oder beim Zurücknehmen');
});

test('viele Geräte: Versand in Paketen kommt vollständig an', async () => {
  received.length = 0;
  const devices = Array.from({ length: 23 }, (_, i) => makeDevice(`viele-${i}`));
  for (const d of devices) await api('POST', '/api/push/subscribe', { subscription: d.subscription, groups: ['Erwachsenentraining'] });
  await api('POST', `/api/occurrences/di-erwachsene@${nextWeekday(2)}/cancel`, {}, token);
  assert.ok(await waitFor(() => received.filter((r) => r.path.includes('viele')).length === 23, 15000), 'alle 23 Geräte erreicht');
  for (const d of devices.slice(0, 3)) {
    const hit = received.find((r) => r.path === new URL(d.subscription.endpoint).pathname);
    assert.match(decrypt(d, hit.body).body, /Erwachsenentraining/);
  }
});

test('Ort nur für einen Termin ändern, Standard bleibt Erlenbach', async () => {
  const key = `fr-team@${nextWeekday(5)}`;
  let s = await api('PUT', `/api/occurrences/${key}/location`, { locationId: 'ilvesheim-neckarstadion' }, token);
  assert.equal(s.status, 200);
  assert.equal(s.data.exceptions[key].locationId, 'ilvesheim-neckarstadion');
  assert.equal(s.data.sessions.find((x) => x.id === 'fr-team').locationId, 'erlenbach-halle', 'Standard unverändert');
  assert.equal((await api('PUT', `/api/occurrences/${key}/location`, { locationId: 'mond' }, token)).status, 400);
  // zurück auf Standard → Ausnahme verschwindet
  s = await api('PUT', `/api/occurrences/${key}/location`, { locationId: 'erlenbach-halle' }, token);
  assert.equal(s.data.exceptions[key], undefined);
  await api('PUT', `/api/occurrences/${key}/location`, { locationId: 'ilvesheim-neckarstadion' }, token);
  s = await api('DELETE', `/api/occurrences/${key}/location`, null, token);
  assert.equal(s.data.exceptions[key], undefined);
});

test('Zu-/Absagen: freiwillig, änderbar, nur für Trainer sichtbar', async () => {
  const key = `mo-nachwuchs@${nextWeekday(1)}`;
  const max = 'geraet-max-1234567890';
  const lisa = 'geraet-lisa-1234567890';
  assert.equal((await api('PUT', '/api/rsvp', { key, deviceId: max, name: 'Max', status: 'yes' })).status, 200);
  assert.equal((await api('PUT', '/api/rsvp', { key, deviceId: lisa, name: 'Lisa', status: 'no' })).status, 200);
  assert.equal((await api('PUT', '/api/rsvp', { key, deviceId: 'kurz', name: 'X', status: 'yes' })).status, 400);
  assert.equal((await api('PUT', '/api/rsvp', { key, deviceId: max, name: '', status: 'yes' })).status, 400, 'Name nötig');
  assert.equal((await api('PUT', '/api/rsvp', { key, deviceId: max, name: 'Max', status: 'vielleicht' })).status, 400);
  assert.equal((await api('PUT', '/api/rsvp', { key: 'mo-nachwuchs@2020-01-06', deviceId: max, name: 'Max', status: 'yes' })).status, 400, 'vorbei');

  // Eigene Antworten
  assert.deepEqual((await api('GET', `/api/rsvp/mine?device=${max}`)).data.rsvps, { [key]: 'yes' });
  // Trainer sieht alle
  let list = (await api('GET', '/api/rsvps', null, token)).data.rsvps[key];
  assert.deepEqual(list, [{ name: 'Max', status: 'yes' }, { name: 'Lisa', status: 'no' }]);
  // ändern & Namen anpassen
  await api('PUT', '/api/rsvp', { key, deviceId: max, name: 'Max', status: 'no' });
  await api('PUT', '/api/device', { deviceId: max, name: 'Max & Ben' });
  list = (await api('GET', '/api/rsvps', null, token)).data.rsvps[key];
  assert.ok(list.some((r) => r.name === 'Max & Ben' && r.status === 'no'));
  // zurücknehmen
  await api('PUT', '/api/rsvp', { key, deviceId: max, status: null });
  assert.deepEqual((await api('GET', `/api/rsvp/mine?device=${max}`)).data.rsvps, {});
  // bei abgesagtem Training nicht möglich
  const canceledKey = `mi-athletik@${nextWeekday(3)}`;
  assert.equal((await api('PUT', '/api/rsvp', { key: canceledKey, deviceId: lisa, name: 'Lisa', status: 'yes' })).status, 409);
});

test('Trainerverwaltung und PIN-Wechsel', async () => {
  let s = await api('POST', '/api/trainers', { name: 'Max Mustermann' }, token);
  const maxT = s.data.trainers.find((t) => t.name === 'Max Mustermann');
  assert.ok(maxT);
  assert.equal((await api('POST', '/api/trainers', { name: 'max mustermann' }, token)).status, 409);
  s = await api('DELETE', `/api/trainers/florian-staiger?replacement=${maxT.id}`, null, token);
  assert.deepEqual(s.data.sessions.find((x) => x.id === 'mi-athletik').trainerIds, [maxT.id]);

  const fr = `fr-team@${nextWeekday(5)}`;
  s = await api('PUT', `/api/occurrences/${fr}/trainers`, { trainerIds: ['sarah-baumgaertner'], scope: 'once' }, token);
  assert.deepEqual(s.data.exceptions[fr].trainerIds, ['sarah-baumgaertner']);
  s = await api('PUT', `/api/occurrences/${fr}/trainers`, { trainerIds: ['sarah-baumgaertner'], scope: 'weekly' }, token);
  assert.deepEqual(s.data.sessions.find((x) => x.id === 'fr-team').trainerIds, ['sarah-baumgaertner']);

  // PIN ändern → alle anderen Anmeldungen ungültig
  const other = (await api('POST', '/api/login', { pin: PIN })).data.token;
  const pin = await api('PUT', '/api/pin', { pin: '8352' }, token);
  assert.equal(pin.status, 200);
  assert.equal((await api('GET', '/api/session', null, other)).status, 401, 'andere Geräte abgemeldet');
  assert.equal((await api('GET', '/api/session', null, pin.data.token)).status, 200);
  assert.equal((await api('POST', '/api/login', { pin: PIN })).status, 403, 'alte PIN gilt nicht mehr');
  token = (await api('POST', '/api/login', { pin: '8352' })).data.token;
  assert.ok(token);
});

test('Aufräumen löscht alte Termine', async () => {
  const oldKey = 'mo-shoshin@2026-01-05';
  // Rückmeldung zu einem alten Termin lässt sich nicht anlegen → direkt über die Absage-Logik prüfen:
  // alte Ausnahme über die API ist für vergangene Termine erlaubt (Trainer), danach räumt der Cron auf.
  await api('POST', `/api/occurrences/${oldKey}/cancel`, { reason: 'alt' }, token);
  assert.ok((await api('GET', '/api/state')).data.exceptions[oldKey]);
  const res = await fetch(`${BASE}/__scheduled?cron=23+2+*+*+*`);
  assert.equal(res.status, 200);
  await sleep(500);
  const state = (await api('GET', '/api/state')).data;
  assert.equal(state.exceptions[oldKey], undefined, 'alte Absage gelöscht');
  assert.ok(Object.keys(state.exceptions).some((k) => k.startsWith('mi-athletik@')), 'kommende Absagen bleiben');
});

test('Schutz gegen PIN-Raten', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await api('POST', '/api/login', { pin: '9999' });
  assert.equal(last.status, 429);
  assert.equal((await api('POST', '/api/login', { pin: '8352' })).status, 429, 'auch richtige PIN vorerst gesperrt');
});
