// Verbindung zum Server (Cloudflare Worker unter /api/).
// Pfade sind relativ, damit die App auch in einem Unterordner läuft.

const TOKEN_KEY = 'takumi74.token';
const MODE_KEY = 'takumi74.mode';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const getToken = () => storage()?.getItem(TOKEN_KEY) || null;

export function setToken(token) {
  try {
    if (token) storage()?.setItem(TOKEN_KEY, token);
    else storage()?.removeItem(TOKEN_KEY);
  } catch {
    /* ignorieren */
  }
}

// Findet heraus, ob die App mit einem Server läuft.
// → { mode: 'server', config } | { mode: 'local' }
// Ohne Netz wird der zuletzt bekannte Modus verwendet.
export async function detectMode() {
  const remembered = storage()?.getItem(MODE_KEY) || 'local';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch('api/config', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    const data = res.ok ? await res.json().catch(() => null) : null;
    const mode = data?.mode === 'server' ? 'server' : 'local';
    try {
      storage()?.setItem(MODE_KEY, mode);
    } catch {
      /* ignorieren */
    }
    return { mode, config: data, online: true };
  } catch {
    return { mode: remembered, config: null, online: false };
  }
}

export async function api(method, path, body, { auth = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  const token = auth ? getToken() : null;
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'Keine Verbindung zum Server. Bist du online?');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error || `Fehler ${res.status}`);
  return data;
}
