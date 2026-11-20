// Benachrichtigungen (Push) und Service Worker.
//
// Demo-Modus: Die Benachrichtigung wird direkt auf dem Gerät angezeigt,
// sobald eine Absage eintrifft (auch aus einem anderen Tab/Fenster).
//
// Mit Server: subscribeServerPush() meldet das Gerät beim Server an.
// Der Server verschickt bei einer Absage echte Web-Push-Nachrichten,
// die der Service Worker (sw.js) auch bei geschlossener App anzeigt.
import { CONFIG } from './config.js';

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

  // Zeigt eine System-Benachrichtigung. Gleicher "tag" ersetzt eine
  // vorhandene Meldung (verhindert Doppelte bei mehreren offenen Tabs).
  async show({ title, body, tag, url = './' }) {
    if (this.permission !== 'granted') return false;
    const options = {
      body,
      tag,
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-72.png',
      data: { url },
    };
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

// Meldet dieses Gerät für echte Push-Nachrichten beim Server an.
// Ohne Server-Konfiguration passiert nichts (Demo-Modus).
export async function subscribeServerPush(groups = []) {
  if (!CONFIG.apiBaseUrl || !CONFIG.vapidPublicKey || !swRegistration?.pushManager) return null;
  const subscription = await swRegistration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(CONFIG.vapidPublicKey),
  });
  await fetch(`${CONFIG.apiBaseUrl}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, groups }),
  });
  return subscription;
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
