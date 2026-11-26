# Übergabe: Trainingsplan-App „Takumi 74“

> **Für Claude:** Diese Datei beschreibt das Projekt vollständig: Ziel, bereits getroffene Entscheidungen, Aufbau, Stand und offene Punkte.
> Lies sie zuerst ganz durch. Die Entscheidungen unter **3.** sind mit dem Auftraggeber abgestimmt. Bitte nicht wieder in Frage stellen, sondern nur ändern, wenn jemand es ausdrücklich wünscht.
> Sprache im Projekt: **Deutsch** (Oberfläche, Code-Kommentare, Commit-Nachrichten).

Stand: 26.11.2026

---

## 1. Worum geht es?

Der Karateverein **Takumi 74** (Erlenbach) teilte Trainingsausfälle bisher nur im WhatsApp-Chat mit. Die App löst das:

- **Eltern & Kinder** sehen den wöchentlichen Trainingsplan und bekommen **sofort eine Push-Nachricht, wenn ein Training ausfällt**.
- **Trainer** (Zugang per PIN) sagen Trainings ab, teilen Trainer ein (Vertretung oder dauerhaft) und ändern den Ort eines Termins.
- Die App muss **einfach und übersichtlich** sein, denn auch Kinder benutzen sie.
- Sie läuft auf **Android und iPhone** als installierbare Web-App (PWA). Verteilt wird sie über einen Link, danach legt man sie auf den Home-Bildschirm. Ein App Store ist nicht nötig.

## 2. Links & Zugänge

| Was | Wo |
|---|---|
| GitHub-Repo | `lukasstock1-lang/Trainingsplan-Takumi`, öffentlich (wegen GitHub Pages) |
| Haupt-Branch | `main`. Der komplette Stand ist dort (PR #1 gemergt). |
| Arbeits-Branch (Claude) | `claude/karate-training-app-11dx51` |
| Demo (ohne Server, nur lokal im Browser) | https://lukasstock1-lang.github.io/Trainingsplan-Takumi/ (GitHub Pages aus dem Arbeits-Branch, Demo-PIN `7474`) |
| Produktiv (mit Server) | Cloudflare Worker `takumi74` → `https://takumi74.<konto>.workers.dev`. **Wird gerade eingerichtet**, siehe Abschnitt 7. |
| Trainer-PIN (produktiv) | Liegt als Secret `TRAINER_PIN` in Cloudflare. **Der Wert steht absichtlich nirgends im Repo.** Ihn kennen Lukas und Lena (Cheftrainerin). |

## 3. Abgestimmte Entscheidungen (nicht ändern ohne Rückfrage)

**Allgemein**
- Zwei Rollen: **Eltern & Kinder** (nur ansehen, benachrichtigt werden, freiwillig zu-/absagen) und **Trainer** (PIN).
- Der Wochenplan ist jede Woche gleich. Ausnahmen gelten **pro Termin** (Schlüssel `<trainingId>@<YYYY-MM-DD>`).
- **Farben:** grün = findet statt, rot (durchgestrichen) = fällt aus, gelb = anderer Ort. Zusätzlich gibt es immer Symbole bzw. Text (✓ / ✕), nicht nur Farbe.
- **Vergangene Trainings werden ausgeblendet.** Beim Öffnen sieht man immer das nächste anstehende Training. Man kann nicht in vergangene Wochen blättern. Ist in der aktuellen Woche nichts mehr, springt die App in die nächste Woche.
- Eltern können **Gruppen filtern** („Meine Gruppen“). Ohne Auswahl sehen sie alle.

**Push-Nachrichten**
- **Push gibt es NUR, wenn ein Training abgesagt wird.**
- **Keine** Push bei: Trainerwechsel, Zurücknehmen einer Absage („Findet doch statt“), **Ortswechsel**. Der Auftraggeber hat ausdrücklich „Nein“ gewählt.
- **Keine** Erinnerungs- oder Abfrage-Pushes mit Zu-/Absage-Knöpfen. Auch das hat der Auftraggeber ausdrücklich abgelehnt.
- Push lässt sich in den Einstellungen per **Schalter** ein- und ausschalten.
- Gruppenfilter gilt auch für Push: Man bekommt nur Nachrichten zu den gewählten Gruppen.

**Zu-/Absagen (RSVP)**
- „Ich komme / Ich komme nicht“ bei jedem kommenden, nicht abgesagten Training, **nur in der App**.
- **Freiwillig** und jederzeit änderbar. Nochmal auf die gewählte Antwort tippen nimmt sie zurück.
- Beim ersten Mal wird nach dem **Namen** gefragt. Geschwister können „Max & Lisa“ eintragen.
- **Nur Trainer sehen die Rückmeldungen**, andere Kinder und Eltern nicht.
- Kein Konto: Ein Gerät wird über eine zufällige Geräte-ID erkannt (localStorage).

**Trainer**
- **Eine gemeinsame 4-stellige PIN**, die Lena per WhatsApp an die Trainer verteilt.
- Trainer per Auswahlfeld ändern, mit Rückfrage „Nur dieser Termin (Vertretung)“ oder „Jede Woche (dauerhaft)“. Bis zu 3 Trainer pro Training (die Shoshin-Gruppe hat 2).
- **Ort per Auswahlfeld, nur für diesen Termin. Standard bleibt immer Erlenbach.** Orte: Erlenbach Friedenstraße 46 (Halle), Erlenbach Talstraße 40 (Standard der Athletikgruppe), Neckarstadion Ilvesheim.
- Einstellungen: Trainer anlegen, umbenennen, entfernen (mit Nachfolger für dessen Trainings).
- **Jeder Trainer darf die PIN in der App ändern.** Dann werden alle Trainer abgemeldet. Der Auftraggeber hat das so akzeptiert.
- Für das Neckarstadion ist die Adresse ohne Straße hinterlegt („Neckarstadion, 68549 Ilvesheim“). Der Auftraggeber hat das so akzeptiert.

**Hosting**
- **Cloudflare, Gratis-Tarif**, ohne Kreditkarte. **Keine eigene Domain nötig**, der `workers.dev`-Link reicht.
- Supabase, Render und Firebase wurden geprüft und verworfen: Supabase pausiert ungenutzte Projekte, Render schläft ein, Firebase braucht eine Kreditkarte.

## 4. Trainingsplan (Quelle: `js/data.js`)

| Tag | Training (`id`) | Zeit | Trainer | Zielgruppe |
|---|---|---|---|---|
| Mo | Takumi Shoshin Gruppe (`mo-shoshin`) | 16:30–18:00 | Djego Wabingga & Ruwantha de Silva | Ab 5 Jahren |
| Mo | Takumi Nachwuchskader (`mo-nachwuchs`) | 17:00–18:00 | Sarah Baumgärtner | |
| Mo | Takumi Wettkampfkader (`mo-wettkampf-1`) | 18:00–19:30 | Lena Staiger | Wettkampfkader 1 |
| Mo | Takumi Wettkampfkader (`mo-wettkampf-2`) | 19:00–20:30 | Lena Staiger | Wettkampfkader 2 |
| Di | Erwachsenentraining (`di-erwachsene`) | 18:00–19:15 | Ruwantha de Silva | Erwachsene |
| Mi | Takumi Nachwuchskader (`mi-nachwuchs`) | 16:00–17:30 | Lena Staiger | |
| Mi | Takumi Wettkampfkader (`mi-wettkampf`) | 17:00–19:00 | Lena Staiger | |
| Mi | Takumi Athletikgruppe (`mi-athletik`) | 19:15–20:15 | Florian Staiger | Ort: **Talstraße 40** |
| Fr | KVBW Landesstützpunkt (`fr-landesstuetzpunkt`) | 17:00–19:00 | Lena Staiger | Wettkampfkader & KVBW Landeskader |
| Fr | Takumi Teamtraining (`fr-team`) | 19:00–20:00 | Lena Staiger | |
| Sa/So | Wettkampftraining (`we-wettkampftraining`) | nach Vereinbarung | Lena Staiger | Starter des kommenden Wettkampfs |

Wenn nicht anders angegeben, ist der Ort Friedenstraße 46, 74235 Erlenbach.
**Neues Training hinzufügen:** in `DEFAULT_SESSIONS` (`js/data.js`) eintragen und deployen. Der Server übernimmt neue Trainings beim Start automatisch (`INSERT OR IGNORE`). Bestehende Trainings werden dabei **nicht** überschrieben. Wer Zeiten bestehender Trainings ändern will, muss das zusätzlich in der Datenbank tun (oder eine kleine Migration/API ergänzen).

## 5. Aufbau & Technik

### Dateien
```
index.html, manifest.webmanifest, sw.js, icons/   → PWA (installierbar, Service Worker für Offline + Push)
css/styles.css     → komplettes Design, hell/dunkel, mobil zuerst, ab 1100px Tage nebeneinander
js/app.js          → alle Ansichten (Start, PIN, Gruppen, Kalender, Einstellungen), Dialoge, Aktionen
js/store.js        → Datenhaltung: Server-Modus oder Demo-Modus, Synchronisation, Zu-/Absagen
js/api.js          → fetch-Wrapper, Modus-Erkennung über GET api/config, Trainer-Token (localStorage)
js/notify.js       → Benachrichtigungen, Service Worker, Push-Abo beim Server
js/schedule.js     → Wochenplan → konkrete Termine (Occurrences), Orte, „nächstes Training“
js/data.js         → Stammdaten: Trainer, Orte, Trainings (wird auch vom Server importiert!)
js/dates.js, js/icons.js, js/config.js (nur Demo-PIN)
server/src/index.js   → Cloudflare Worker: API /api/*, Push-Versand, Cron-Aufräumen
server/src/setup.js   → richtet beim ersten Aufruf Tabellen, Startdaten und Schlüssel (VAPID, Auth) ein
server/src/webpush.js → Web-Push (RFC 8291 aes128gcm + RFC 8292 VAPID) nur mit WebCrypto
server/test/api.test.js → Server-Tests (startet wrangler dev mit leerer DB + simuliertem Push-Dienst)
wrangler.toml      → Worker "takumi74", Assets = Projektordner, D1-Binding DB, Cron 02:23 UTC
.assetsignore      → was NICHT ausgeliefert wird (server/, node_modules, docs, Konfig …)
ANLEITUNG-CLOUDFLARE.md → Schritt-für-Schritt-Anleitung zum Veröffentlichen (auch Text für WhatsApp)
```
Die App selbst hat **keinen Build-Schritt** (Vanilla JS, ES-Module). Nur der Worker wird von Wrangler gebündelt.

### Zwei Modi (automatisch erkannt)
- **Server-Modus** (Cloudflare): `GET api/config` liefert `{mode:'server'}`. Die Daten liegen in D1 und gelten für alle. Die App lädt neu beim Start, bei Fokus/Sichtbarkeit, jede Minute und sofort, wenn eine Push-Nachricht eingeht (der Service Worker schickt dann `postMessage refresh`).
- **Demo-Modus** (GitHub Pages / `python3 -m http.server`): `api/config` liefert 404. Alles liegt im localStorage, mehrere Tabs synchronisieren sich über das `storage`-Event, Demo-PIN `7474`. Die 404-Meldung in der Konsole ist gewollt.

### Datenmodell (D1, Schema in `server/src/setup.js`)
- `trainers(id, name, sort)` und `sessions(id, weekday 1–7, title, audience, start_time, end_time, time_text, location_id, trainer_ids JSON, sort)`
- `exceptions(key, canceled, reason, canceled_at, trainer_ids, location_id)`: Ausnahmen pro Termin. Leere Zeilen werden gelöscht.
- `events(id, type, key, reason, at, origin)`: Protokoll der Absagen. Daraus kommen die In-App-Hinweise, `origin` = Tab-ID des Absenders.
- `subscriptions(endpoint, p256dh, auth, groups JSON, …)` für Push-Abos
- `rsvps(key, device_id, name, status 'yes'|'no', updated_at)` für Zu-/Absagen
- `settings` (auth_secret, vapid_public, vapid_private, pin_salt, pin_hash) und `login_attempts`
- **Orte** sind keine Tabelle, sie kommen aus `DEFAULT_LOCATIONS` in `js/data.js`.

### API (alle unter `/api/`)
Öffentlich:
- `GET config`, `GET health`, `GET state`, `POST login {pin}`
- `POST push/subscribe {subscription, groups}`, `POST push/unsubscribe`, `POST push/test {endpoint}`
- `PUT rsvp {key, deviceId, name, status}`, `GET rsvp/mine?device=`, `PUT device {deviceId, name}`

Nur Trainer (Header `Authorization: Bearer <token>`):
- `POST/DELETE occurrences/{key}/cancel`, `PUT/DELETE occurrences/{key}/trainers {trainerIds, scope:'once'|'weekly'}`, `PUT/DELETE occurrences/{key}/location {locationId}`
- `GET rsvps`, `POST trainers`, `PATCH/DELETE trainers/{id}?replacement=`, `PUT pin`, `GET session`

Intern: `POST internal/push`, geschützt über den Header `x-internal-token`.

### Wichtige technische Details
- **Push-Versand:** Pro Gerät braucht das Verschlüsseln etwa **0,6 ms CPU**, im Gratis-Tarif sind 10 ms pro Aufruf erlaubt. Deshalb verschickt der Worker in **Paketen zu je 10 Geräten**, jedes Paket in einem eigenen Aufruf über **`ctx.exports.default.fetch`** (Selbstaufruf, verfügbar ab `compatibility_date` 2025-11-17). Pro Paket wird ein Absender-Schlüsselpaar wiederverwendet. Geräte, die mit 404/410 antworten, werden gelöscht.
- **Trainer-Login:** Die PIN wird auf dem Server geprüft. Zuerst gilt `settings.pin_hash` (nach einer Änderung in der App), sonst das Secret `TRAINER_PIN`. Das Token ist mit HMAC signiert, mit `auth_secret` plus PIN-Material als Schlüssel. Ändert sich die PIN, sind damit alle Tokens ungültig. Sperre: 5 Fehlversuche pro 15 Minuten und IP, 30 pro Stunde insgesamt.
- **Selbst-Einrichtung:** Beim ersten Request pro Worker-Instanz laufen `CREATE TABLE IF NOT EXISTS`, die Startdaten werden eingespielt und die Schlüssel erzeugt. Von Hand gesetzt wird nur `TRAINER_PIN`.
- **D1 wird beim ersten `wrangler deploy` automatisch angelegt** (Wrangler 4.165 kann Ressourcen automatisch bereitstellen, deshalb hat `wrangler.toml` keine `database_id`). Wrangler ist in `package.json` **exakt auf 4.165.0 festgelegt**.
- **Cron** (täglich): löscht Ausnahmen und Rückmeldungen, die älter als 14 Tage sind, Events älter als 60 Tage und alte Login-Versuche.
- **Service Worker:** lädt immer zuerst aus dem Netz und nimmt den Cache nur als Rückfall. `/api/` wird nie gecacht. Nach Änderungen an App-Dateien die Version `CACHE` in `sw.js` hochzählen (aktuell `takumi74-v3`).
- **iPhone:** Push gibt es erst ab iOS 16.4 und **nur, wenn die App vom Home-Bildschirm gestartet wird**. Ohne Installation zeigt die App eine Anleitung („Teilen → Zum Home-Bildschirm“). Auf Android erscheint der Knopf „Installieren“ (`beforeinstallprompt`).
- **Das Repo ist öffentlich:** Niemals Secrets oder die PIN einchecken. `.dev.vars` steht in `.gitignore`.

## 6. Entwickeln & Testen

```bash
npm install
echo "TRAINER_PIN=1234" > .dev.vars            # lokale PIN (nicht einchecken)
npm run dev                                    # http://localhost:8787 mit lokaler D1
npm test                                       # 9 Server-Tests (ca. 1 Min.)
```
- `npm test` startet selbst einen `wrangler dev` auf Port 8799 mit leerer DB und einem simulierten Push-Dienst auf Port 9911. Die Push-Payloads werden **unabhängig mit node:crypto entschlüsselt**, die VAPID-Signatur wird geprüft.
- Für lokale Push-Tests mit erfundenen Endpunkten `ALLOW_ANY_PUSH_ENDPOINT=1` in `.dev.vars` setzen. In Produktion sind nur echte Push-Dienste erlaubt (Google, Mozilla, Apple, Microsoft).
- Browser-Tests wurden mit Playwright gemacht, liegen aber **nicht im Repo**. Hinweise dazu: Headless-Chromium braucht `chromium.launch({ channel: 'chromium' })`, damit Benachrichtigungen erlaubt sind. `context.clock.install({ time })` setzt die Uhrzeit (z. B. Montag 8 Uhr). `pushManager` lässt sich per `addInitScript` durch ein Abo auf einen lokalen Mock-Push-Dienst ersetzen.
- Demo-Modus testen: `python3 -m http.server 8080` im Projektordner.

## 7. Stand & nächste Schritte

**Erledigt:** App, Server, Tests, Anleitung. PR #1 ist in `main` gemergt.

**Gerade in Arbeit: Veröffentlichung auf Cloudflare** (siehe `ANLEITUNG-CLOUDFLARE.md`):
1. ✅ PR gemergt
2. ⏳ Cloudflare → Workers & Pages → **Repository importieren** (nicht „Hochladen“, das kann keinen Worker-Code). Projektname **`takumi74`**, Branch **`main`**, Build-Befehl leer, Deploy-Befehl `npx wrangler deploy`
3. ⏳ Secret `TRAINER_PIN` setzen
4. ⏳ `https://takumi74.<konto>.workers.dev/api/health` muss `"allesBereit": true` zeigen
5. ⏳ Auf echten Geräten testen (Android + iPhone): installieren, Push aktivieren, als Trainer absagen, Push kommt an
6. ⏳ Link verteilen (Text für WhatsApp steht in der Anleitung), **QR-Code** für den Aushang in der Halle erstellen

**Wenn etwas hakt:**
- `/api/health` meldet `datenbank: fehlt`: D1 von Hand anlegen (Name `takumi74`) und im Worker unter Einstellungen → Bindungen als `DB` verbinden.
- Der Build scheitert am Namen: Projektname muss genau `takumi74` heißen (wie `name` in `wrangler.toml`).

**Danach aufräumen:**
- GitHub Pages abschalten (Repo → Settings → Pages). Die Seite ist nur noch Demo.
- Danach kann das Repo wieder **privat** werden. Cloudflare Workers Builds funktioniert auch mit privaten Repos.
- Alte Home-Bildschirm-Verknüpfungen zur GitHub-Demo löschen und durch den Cloudflare-Link ersetzen.

## 8. Mögliche Erweiterungen (nur auf Wunsch)
- PIN-Änderung nur für Lena (eigene Admin-PIN)
- Genaue Straße des Neckarstadions ergänzen
- Weitere Orte verwalten (bisher feste Liste in `js/data.js`)
- Zeiten bestehender Trainings in der App bearbeiten (bisher nur Trainer, Ort und Ausfall pro Termin)
- Eigene Domain (z. B. `app.takumi74.de`) über Worker → Einstellungen → Domains & Routen

---

### Startnachricht für Claude (zum Kopieren)

> Ich übernehme die Trainingsplan-App von Takumi 74. Bitte lies zuerst die angehängte Übergabe-Datei (bzw. `docs/UEBERGABE.md` im Repo `lukasstock1-lang/Trainingsplan-Takumi`). Halte dich an die abgestimmten Entscheidungen in Abschnitt 3. Antworte auf Deutsch. Mein nächstes Ziel ist: …
