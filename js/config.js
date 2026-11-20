// Zentrale Konfiguration der App.
//
// Ob die App mit Server läuft, erkennt sie selbst: Antwortet "api/config",
// ist sie im Server-Modus (Cloudflare). Sonst läuft sie als Demo nur auf dem
// Gerät (z. B. GitHub Pages oder lokal mit "python3 -m http.server").
export const CONFIG = {
  // Trainer-PIN im Demo-Modus (in den Einstellungen änderbar).
  // Im Server-Modus wird die PIN auf dem Server geprüft.
  demoPin: '7474',
};
