// Benachrichtigungen (Push) und Service Worker.
//
// Server-Modus: Das Gerät meldet sich mit pushManager.subscribe() beim Server an.
// Bei einer Absage verschickt der Server echte Web-Push-Nachrichten, die der
// Service Worker (sw.js) auch bei geschlossener App anzeigt.
//
// Demo-Modus: Die Benachrichtigung wird direkt auf dem Gerät angezeigt,
// sobald eine Absage eintrifft (auch aus einem anderen Tab/Fenster).
import { api } from './api.js';

let swRegistration = null;

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    swRegistration = await navigator.serviceWorker.register('./sw.js');
    return swRegistration;
  } catch {
    return null; // z. B. bei file:// oder in eingebetteten Vorschauen
  }
}

async function readyRegistration() {
  if (swRegistration?.active) return swRegistration;
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 8000))]);
}

export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

export const notifier = {
  get supported() {
    return 'Notification' in window;
  },

  get permission() {
    return this.supported ? Notification.permission : 'unsupported';
  },

  async request() {
    if (!this.supported) return 'unsupported';
    try {
      return await Notification.requestPermission();
    } catch {
      return Notification.permission;
    }
  },

  // Zeigt eine System-Benachrichtigung auf diesem Gerät. Gleicher "tag"
  // ersetzt eine vorhandene Meldung (verhindert Doppelte).
  async show({ title, body, tag, url = './' }) {
    if (this.permission !== 'granted') return false;
    const options = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/badge-72.png', data: { url } };
    try {
      const reg = swRegistration || (await navigator.serviceWorker?.getRegistration());
      if (reg) {
        await reg.showNotification(title, options);
        return true;
      }
    } catch {
      /* Fallback unten */
    }
    try {
      new Notification(title, options);
      return true;
    } catch {
      return false;
    }
  },
};

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const sameKey = (a, b) => !!a && !!b && a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === b[i]);

// Meldet dieses Gerät beim Server für Push-Nachrichten an (oder aktualisiert die Gruppen).
export async function subscribeServerPush(vapidPublicKey, groups = []) {
  if (!vapidPublicKey) throw new Error('Push ist auf dem Server noch nicht eingerichtet.');
  const reg = await readyRegistration();
  if (!reg?.pushManager) throw new Error('Push wird von diesem Gerät nicht unterstützt.');
  const key = urlBase64ToUint8Array(vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe(); // Abo mit altem Server-Schlüssel ersetzen
    sub = null;
  }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('POST', 'api/push/subscribe', { subscription: sub.toJSON(), groups });
  return sub;
}

export async function unsubscribeServerPush() {
  const reg = await readyRegistration();
  const sub = await reg?.pushManager?.getSubscription();
  if (!sub) return;
  await api('POST', 'api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

// Lässt den Server eine Test-Nachricht an genau dieses Gerät schicken.
export async function sendServerTestPush() {
  const reg = await readyRegistration();
  const sub = await reg?.pushManager?.getSubscription();
  if (!sub) throw new Error('Dieses Gerät ist nicht für Push angemeldet.');
  return api('POST', 'api/push/test', { endpoint: sub.endpoint });
}
