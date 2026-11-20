// Erzeugt die Server-Geheimnisse (einmalig vor dem ersten Deploy).
// Aufruf: node server/scripts/generate-secrets.js  → gibt JSON aus (für "wrangler secret bulk")
import { webcrypto as crypto } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
const pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);

console.log(
  JSON.stringify(
    {
      VAPID_PUBLIC_KEY: b64url(publicRaw),
      VAPID_PRIVATE_KEY: jwk.d,
      AUTH_SECRET: b64url(crypto.getRandomValues(new Uint8Array(32))),
      INITIAL_PIN: pin,
    },
    null,
    2,
  ),
);
