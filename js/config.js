// Zentrale Konfiguration der App.
// Sobald ein Server existiert, werden hier die Adressen/Schlüssel eingetragen.
export const CONFIG = {
  // Basis-URL der späteren API, z. B. 'https://api.takumi74.de'.
  // null = Demo-Modus: alle Daten liegen nur lokal im Browser.
  apiBaseUrl: null,

  // Öffentlicher VAPID-Schlüssel für echte Web-Push-Nachrichten (kommt vom Server).
  // null = Push wird nur lokal auf dem Gerät angezeigt (Demo).
  vapidPublicKey: null,

  // Trainer-PIN im Demo-Modus (in den Einstellungen änderbar).
  demoPin: '7474',
};
