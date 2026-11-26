# Anleitung: Takumi-74-App auf Cloudflare veröffentlichen

**Ergebnis:** Die App ist unter einem festen Link erreichbar, zum Beispiel
`https://takumi74.<dein-name>.workers.dev`. Eltern öffnen den Link und legen die App auf den Home-Bildschirm.

- **Domain:** Du brauchst keine eigene Domain, der `workers.dev`-Link reicht.
- **Kosten:** 0 €. Der Gratis-Tarif von Cloudflare reicht für den Verein bei Weitem.
- **Dauer:** etwa 10 Minuten, alles geht auch vom Handy aus.

Cloudflare holt sich die App direkt aus eurem GitHub-Repo, du musst also keine Dateien hochladen. Jede Änderung im Repo wird danach automatisch veröffentlicht.

---

## Schritt 1 – Pull Request zusammenführen (GitHub)

1. Auf GitHub das Repo **Trainingsplan-Takumi** öffnen → **Pull requests** → **#1**.
2. Unten auf **„Ready for review“** tippen, dann **„Merge pull request“** → **„Confirm merge“**.

Danach liegt die App im Branch `main`.

## Schritt 2 – App mit Cloudflare verbinden

1. **dash.cloudflare.com** öffnen und anmelden.
2. Links im Menü **Workers & Pages** öffnen (manchmal unter „Compute“ / „Rechenleistung“).
3. **Erstellen** (Create) → **Repository importieren** bzw. **Mit Git verbinden** (Import a repository) → **GitHub** wählen und Cloudflare den Zugriff auf das Repo **Trainingsplan-Takumi** erlauben.
4. Das Repo **Trainingsplan-Takumi** auswählen und so einstellen:

   | Feld | Eintrag |
   |---|---|
   | Projektname | **`takumi74`** (genau so schreiben) |
   | Branch | **`main`** |
   | Build-Befehl | leer lassen |
   | Deploy-Befehl | `npx wrangler deploy` (steht meist schon da) |

5. **Erstellen und bereitstellen** (Create and deploy) tippen und 1–2 Minuten warten.
   Beim ersten Mal legt Cloudflare dabei automatisch die Datenbank `takumi74` an.

## Schritt 3 – Trainer-PIN hinterlegen

1. In Cloudflare den Worker **takumi74** öffnen → **Einstellungen** (Settings) → **Variablen und Geheimnisse** (Variables and Secrets).
2. **Hinzufügen** (Add):
   - Typ: **Geheimnis** (Secret)
   - Name: **`TRAINER_PIN`**
   - Wert: die 4-stellige Trainer-PIN, die du von mir im Chat bekommen hast
3. **Bereitstellen** (Deploy) tippen.

> Die PIN steht absichtlich **nicht** im Repo, weil das Repo öffentlich ist. Lena gibt sie per WhatsApp an die Trainer weiter.

## Schritt 4 – Prüfen, ob alles bereit ist

1. Oben beim Worker steht die Adresse, z. B. `https://takumi74.<dein-name>.workers.dev`.
2. Diese Adresse mit **`/api/health`** am Ende öffnen, also `https://takumi74.<dein-name>.workers.dev/api/health`.
3. Dort muss **`"allesBereit": true`** stehen. Wenn nicht, hilft der Abschnitt „Wenn etwas nicht klappt“ unten.
4. Danach die normale Adresse (ohne `/api/health`) öffnen und einmal als Trainer mit der PIN anmelden.

**Fertig!** 🎉 Jetzt nur noch den Link verteilen (Text siehe unten).

---

## Text für die WhatsApp-Gruppe

> 🥋 **Neu: Unser Trainingsplan als App!**
> Ab sofort seht ihr dort, ob ein Training stattfindet. Fällt eins aus, bekommt ihr sofort eine Nachricht.
>
> 👉 **LINK HIER EINFÜGEN**
>
> **iPhone:** Link in **Safari** öffnen → unten auf **Teilen** (Quadrat mit Pfeil) → **„Zum Home-Bildschirm“**. Dann die App **vom Home-Bildschirm** öffnen und **„Aktivieren“** tippen.
> **Android:** Link in **Chrome** öffnen → **„Installieren“** bzw. im Menü ⋮ **„Zum Startbildschirm hinzufügen“**. App öffnen und **„Aktivieren“** tippen.
>
> Bei jedem Training könnt ihr freiwillig **„Ich komme“ / „Ich komme nicht“** antippen. Das sehen nur die Trainer.

Wenn ihr den Link habt, kann ich daraus auch einen **QR-Code zum Aushängen in der Halle** machen.

---

## Wenn etwas nicht klappt

| Problem | Lösung |
|---|---|
| `/api/health` zeigt `"datenbank": "fehlt"` | Datenbank von Hand anlegen: **Speicher & Datenbanken → D1 → Datenbank erstellen**, Name `takumi74`. Dann **Worker takumi74 → Einstellungen → Bindungen → Hinzufügen → D1-Datenbank**: Variablenname **`DB`**, Datenbank `takumi74` → Speichern. |
| `/api/health` zeigt `"trainerPin": "fehlt …"` | Schritt 3 wiederholen. Der Name muss genau `TRAINER_PIN` lauten. |
| Der Build schlägt fehl, Meldung mit „name“ | Der Projektname muss genau **`takumi74`** heißen. |
| Auf dem iPhone kommen keine Push-Nachrichten | Die App muss über den Home-Bildschirm geöffnet werden (nicht in Safari), und das iPhone braucht mindestens iOS 16.4. In der App unter ⚙️ → Benachrichtigungen kann man eine **Test-Nachricht senden**. |
| Trainer-PIN wird nicht angenommen | Nach 5 Fehlversuchen ist die Anmeldung 15 Minuten gesperrt (Schutz gegen Raten). |

---

## Später

- **Änderungen an der App:** Alles, was im GitHub-Branch `main` landet, veröffentlicht Cloudflare automatisch.
- **Trainer-PIN ändern:** in der App unter Trainer → ⚙️ → **Trainer-PIN ändern**. Alle Trainer werden dabei abgemeldet und brauchen die neue PIN. Danach gilt die PIN aus der App, das Geheimnis `TRAINER_PIN` wird dann nicht mehr verwendet.
- **Eigene Adresse (optional):** Habt ihr eine Domain bei Cloudflare, geht das unter **Worker → Einstellungen → Domains & Routen**, z. B. `app.takumi74.de`.
- **Aufräumen:** Jede Nacht löscht die App automatisch alte Termine und Rückmeldungen (älter als 14 Tage).

---

## Alternative: mit einem Computer veröffentlichen

Diesen Weg brauchst du nur, wenn du nicht über GitHub gehen willst. Er nutzt das ZIP-Archiv mit allen Dateien.

1. [Node.js](https://nodejs.org) installieren (Version 20 oder neuer).
2. ZIP entpacken und im Ordner ein Terminal öffnen.
3. Nacheinander ausführen:
   ```bash
   npm install
   npx wrangler login              # öffnet den Browser zur Cloudflare-Anmeldung
   npx wrangler deploy             # legt Datenbank und App an
   npx wrangler secret put TRAINER_PIN   # danach die PIN eingeben
   ```
4. Weiter mit **Schritt 4** oben.
