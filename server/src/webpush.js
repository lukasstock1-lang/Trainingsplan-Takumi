// Web-Push nach Standard (RFC 8291 Verschlüsselung "aes128gcm", RFC 8292 VAPID).
// Nutzt nur WebCrypto – läuft in Cloudflare Workers, im Browser und in Node.

const encoder = new TextEncoder();

export const b64url = {
  encode(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const pad = '='.repeat((4 - (str.length % 4)) % 4);
    const bin = atob((str + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// HKDF-Expand (RFC 5869) für Ausgabelängen bis 32 Byte.
async function hkdfExpand(prk, info, length) {
  return (await hmacSha256(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

const INFO_WEBPUSH = encoder.encode('WebPush: info\0');
const INFO_CEK = encoder.encode('Content-Encoding: aes128gcm\0');
const INFO_NONCE = encoder.encode('Content-Encoding: nonce\0');

// Schlüsselpaar des Servers für eine Nachricht. Für ein Paket von Empfängern
// wird es wiederverwendet (spart Rechenzeit); Salz und Schlüssel bleiben je
// Empfänger verschieden, da sich das ECDH-Geheimnis pro Gerät unterscheidet.
export async function createSenderKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { privateKey: pair.privateKey, publicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

// Verschlüsselt die Nachricht für ein Abo (p256dh + auth aus der PushSubscription).
export async function encryptPayload(payload, p256dh, authSecret, sender) {
  const uaPublic = b64url.decode(p256dh);
  const auth = b64url.decode(authSecret);
  const { privateKey, publicRaw: asPublic } = sender || (await createSenderKeys());

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, privateKey, 256));

  // IKM = HKDF(auth, ecdh_secret, "WebPush: info" || ua_public || as_public, 32)
  const prkKey = await hmacSha256(auth, ecdhSecret);
  const ikm = await hkdfExpand(prkKey, concat(INFO_WEBPUSH, uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const cek = await hkdfExpand(prk, INFO_CEK, 16);
  const nonce = await hkdfExpand(prk, INFO_NONCE, 12);

  const plaintext = concat(encoder.encode(payload), new Uint8Array([2])); // 0x02 = letzter Datensatz
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));

  // Header: salt (16) | record size (4) | key id length (1) | key id = as_public (65)
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

async function importVapidKey({ publicKey, privateKey }) {
  const pub = b64url.decode(publicKey);
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: privateKey, x: b64url.encode(pub.slice(1, 33)), y: b64url.encode(pub.slice(33, 65)), ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

// Signiertes VAPID-Token für einen Push-Dienst (z. B. https://fcm.googleapis.com).
export async function createVapidJwt(audience, vapid) {
  const header = b64url.encode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url.encode(
    encoder.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject })),
  );
  const unsigned = `${header}.${claims}`;
  const key = await importVapidKey(vapid);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned));
  return `${unsigned}.${b64url.encode(new Uint8Array(signature))}`;
}

// Schickt eine Push-Nachricht. Gibt den HTTP-Status des Push-Dienstes zurück
// (201 = angenommen, 404/410 = Abo existiert nicht mehr).
export async function sendWebPush(subscription, payload, { vapid, jwtCache, sender, ttl = 86400, urgency = 'high' }) {
  const audience = new URL(subscription.endpoint).origin;
  let jwt = jwtCache?.get(audience);
  if (!jwt) {
    jwt = await createVapidJwt(audience, vapid);
    jwtCache?.set(audience, jwt);
  }
  const body = await encryptPayload(payload, subscription.p256dh, subscription.auth, sender);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      TTL: String(ttl),
      Urgency: urgency,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
    },
    body,
  });
  return res.status;
}
