// Server-Test: startet den Worker lokal (eigene Test-Datenbank), simuliert einen
// Push-Dienst und prüft API, Trainer-Login und Push-Nachrichten Ende-zu-Ende.
// Aufruf: npm test
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
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

// --- Geheimnisse nur für den Test ---
const vapid = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const vapidJwk = vapid.privateKey.export({ format: 'jwk' });
const vapidPublic = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(vapidJwk.x, 'base64url'), Buffer.from(vapidJwk.y, 'base64url')]));

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

function verifyVapid(header, audience) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, 'Authorization-Header im VAPID-Format');
  assert.equal(m[2], vapidPublic, 'öffentlicher Schlüssel stimmt');
  const [h, c, s] = m[1].split('.');
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: vapid.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  assert.ok(ok, 'VAPID-Signatur gültig');
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

const nextWeekday = (weekday) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((weekday - (d.getUTCDay() || 7) + 7) % 7) + 7);
  return d.toISOString().slice(0, 10);
};
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

let worker;
before(async () => {
  await new Promise((r) => pushServer.listen(PUSH_PORT, '127.0.0.1', r));
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist], { stdio: 'ignore' });
  const vars = {
    AUTH_SECRET: b64u(crypto.randomBytes(32)),
    INITIAL_PIN: PIN,
    VAPID_PUBLIC_KEY: vapidPublic,
    VAPID_PRIVATE_KEY: vapidJwk.d,
    ALLOW_ANY_PUSH_ENDPOINT: '1',
  };
  const args = ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist, '--env-file', '/dev/null'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  worker = spawn('npx', args, { stdio: 'ignore', env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      ready = (await fetch(`${BASE}/api/config`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert.ok(ready, 'Worker gestartet');
});

after(() => {
  worker?.kill();
  pushServer.close();
  rmSync(persist, { recursive: true, force: true });
});

test('öffentliche Daten', async () => {
  const cfg = await api('GET', '/api/config');
  assert.equal(cfg.data.mode, 'server');
  assert.equal(cfg.data.vapidPublicKey, vapidPublic);
  const { data } = await api('GET', '/api/state');
  assert.equal(data.trainers.length, 5);
  assert.equal(data.sessions.length, 10);
  assert.deepEqual(data.sessions.find((s) => s.id === 'mo-shoshin').trainerIds, ['djego-wabingga', 'ruwantha-de-silva']);
  assert.equal(data.sessions.find((s) => s.id === 'we-wettkampftraining').timeText, 'Nach Vereinbarung');
});

test('Trainer-Aktionen ohne Anmeldung sind gesperrt', async () => {
  const key = `mo-shoshin@${nextWeekday(1)}`;
  assert.equal((await api('POST', `/api/occurrences/${key}/cancel`, {})).status, 401);
  assert.equal((await api('POST', '/api/trainers', { name: 'X' }, 'gefälscht.token')).status, 401);
  assert.equal((await api('POST', '/api/internal/push', { targets: [] })).status, 403);
});

test('Login, Absage mit Push, Vertretung, Trainerverwaltung, PIN', async () => {
  assert.equal((await api('POST', '/api/login', { pin: '0000' })).status, 403);
  const login = await api('POST', '/api/login', { pin: PIN });
  assert.equal(login.status, 200);
  let token = login.data.token;

  // Geräte anmelden: alle Gruppen, nur Athletik, ein abgelaufenes Abo
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
  assert.equal(received[0].path, '/push/athletik');
  assert.match(decrypt(athletik, received[0].body).body, /Test erfolgreich/);
  assert.equal((await api('POST', '/api/push/test', { endpoint: 'http://unbekannt' })).status, 404);
  received.length = 0;

  // Falsches Datum (kein Montag) wird abgelehnt
  assert.equal((await api('POST', `/api/occurrences/mo-shoshin@${nextWeekday(2)}/cancel`, {}, token)).status, 400);

  // Absage
  const key = `mo-shoshin@${nextWeekday(1)}`;
  const res = await api('POST', `/api/occurrences/${key}/cancel`, { reason: 'Halle gesperrt', origin: 'tab1' }, token);
  assert.equal(res.status, 200);
  assert.equal(res.data.exceptions[key].canceled, true);
  assert.equal(res.data.events.at(-1).key, key);
  assert.equal(res.data.events.at(-1).origin, 'tab1');

  assert.ok(await waitFor(() => received.length >= 2), `Push angekommen (${received.length})`);
  await new Promise((r) => setTimeout(r, 500));
  const paths = received.map((r) => r.path).sort();
  assert.deepEqual(paths, ['/push/all', '/push/gone'], 'nur passende Gruppen bekommen die Nachricht');

  const msg = received.find((r) => r.path === '/push/all');
  assert.equal(msg.headers['content-encoding'], 'aes128gcm');
  assert.ok(Number(msg.headers.ttl) > 0);
  verifyVapid(msg.headers.authorization, `http://127.0.0.1:${PUSH_PORT}`);
  const payload = decrypt(all, msg.body);
  assert.equal(payload.title, '❌ Training fällt aus');
  assert.match(payload.body, /Takumi Shoshin Gruppe\nMo, \d\d\.\d\d\. · 16:30 – 18:00 Uhr\nGrund: Halle gesperrt/);
  assert.equal(payload.tag, key);

  // Abgelaufenes Abo (410) wurde entfernt → zweite Absage geht nicht mehr dorthin
  received.length = 0;
  const key2 = `mi-athletik@${nextWeekday(3)}`;
  await api('POST', `/api/occurrences/${key2}/cancel`, { reason: '' }, token);
  assert.ok(await waitFor(() => received.length >= 2));
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(received.map((r) => r.path).sort(), ['/push/all', '/push/athletik']);
  assert.doesNotMatch(decrypt(athletik, received.find((r) => r.path === '/push/athletik').body).body, /Grund/);

  // Doppelte Absage → keine zweite Push-Nachricht
  received.length = 0;
  await api('POST', `/api/occurrences/${key2}/cancel`, { reason: 'Krankheit' }, token);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(received.length, 0, 'keine doppelte Push-Nachricht');

  // Zurücknehmen → keine Push-Nachricht
  const back = await api('DELETE', `/api/occurrences/${key}/cancel`, null, token);
  assert.equal(back.data.exceptions[key], undefined);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(received.length, 0, 'keine Push-Nachricht beim Zurücknehmen');

  // Vertretung nur für einen Termin
  const fr = `fr-team@${nextWeekday(5)}`;
  let s = await api('PUT', `/api/occurrences/${fr}/trainers`, { trainerIds: ['florian-staiger'], scope: 'once' }, token);
  assert.deepEqual(s.data.exceptions[fr].trainerIds, ['florian-staiger']);
  assert.deepEqual(s.data.sessions.find((x) => x.id === 'fr-team').trainerIds, ['lena-staiger']);
  // dauerhaft
  s = await api('PUT', `/api/occurrences/${fr}/trainers`, { trainerIds: ['sarah-baumgaertner'], scope: 'weekly' }, token);
  assert.deepEqual(s.data.sessions.find((x) => x.id === 'fr-team').trainerIds, ['sarah-baumgaertner']);
  assert.equal(s.data.exceptions[fr], undefined);
  assert.equal((await api('PUT', `/api/occurrences/${fr}/trainers`, { trainerIds: ['gibts-nicht'], scope: 'once' }, token)).status, 400);

  // Trainer anlegen, umbenennen, entfernen mit Nachfolger
  s = await api('POST', '/api/trainers', { name: 'Max Mustermann' }, token);
  const max = s.data.trainers.find((t) => t.name === 'Max Mustermann');
  assert.ok(max);
  assert.equal((await api('POST', '/api/trainers', { name: 'max mustermann' }, token)).status, 409);
  s = await api('PATCH', `/api/trainers/${max.id}`, { name: 'Max Muster' }, token);
  assert.ok(s.data.trainers.some((t) => t.name === 'Max Muster'));
  s = await api('DELETE', `/api/trainers/florian-staiger?replacement=${max.id}`, null, token);
  assert.ok(!s.data.trainers.some((t) => t.id === 'florian-staiger'));
  assert.deepEqual(s.data.sessions.find((x) => x.id === 'mi-athletik').trainerIds, [max.id]);

  // PIN ändern → alter Token ungültig, neuer gültig
  const pin = await api('PUT', '/api/pin', { pin: '123456' }, token);
  assert.equal(pin.status, 200);
  assert.equal((await api('GET', '/api/session', null, token)).status, 401, 'alter Token ungültig');
  token = pin.data.token;
  assert.equal((await api('GET', '/api/session', null, token)).status, 200);
  assert.equal((await api('POST', '/api/login', { pin: PIN })).status, 403, 'Start-PIN gilt nicht mehr');
  assert.equal((await api('POST', '/api/login', { pin: '123456' })).status, 200);
});

test('Schutz gegen PIN-Raten', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await api('POST', '/api/login', { pin: '9999' });
  assert.equal(last.status, 429);
});
