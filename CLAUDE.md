# CLAUDE.md – Trainingsplan Takumi 74

Vollständige Übergabe mit allen Entscheidungen, Aufbau und Stand: **[docs/UEBERGABE.md](docs/UEBERGABE.md)**. Vor jeder Änderung lesen.

## Kurzregeln
- Sprache: **Deutsch** (Oberfläche, Kommentare, Commit-Nachrichten).
- **Push-Nachrichten nur bei Absage eines Trainings.** Keine Push bei Trainer- oder Ortswechsel, beim Zurücknehmen einer Absage oder als Erinnerung. Das ist mit dem Verein so abgestimmt.
- Zu-/Absagen sind freiwillig, nur in der App, und **nur Trainer sehen die Namen**.
- Ort wird nur pro Termin geändert, Standard bleibt Erlenbach.
- Das Repo ist **öffentlich**: keine Secrets und nicht die Trainer-PIN einchecken (`TRAINER_PIN` ist ein Cloudflare-Secret, `.dev.vars` ist ignoriert).
- Die App hat keinen Build-Schritt (Vanilla JS). Nach Änderungen an App-Dateien `CACHE` in `sw.js` hochzählen.
- Neue Trainings in `js/data.js` eintragen. Der Server ergänzt sie beim Start automatisch.
- Wrangler bleibt auf **4.165.0** festgelegt (legt D1 automatisch an).

## Befehle
```bash
npm install
npm run dev      # lokal mit D1, braucht .dev.vars mit TRAINER_PIN=…
npm test         # Server-Tests (Push-Verschlüsselung, API, PIN-Schutz …)
```
Demo ohne Server: `python3 -m http.server 8080` (Demo-PIN 7474).
