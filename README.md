# PublicCards

Eine login-freie Canvas-, Bild- & Kommentar-**PWA**. Frontend ist statisch (Vanilla JS, kein Build-Step) auf **GitHub Pages**, Backend ist eine einzelne **Google-Sheets**-Datei über ein **Google-Apps-Script**-Web-API.

- Jeder legt in Sekunden eine Identität an (Vor-/Nachname + global eindeutiger Namespace + geheimer Token, lokal gespeichert, geräteübergreifend übernehmbar).
- **Cards** = Canvases aus Markdown + Bildern, Sichtbarkeit `private` / `public` / `space`.
- Stabile Deep-Links (inkl. direktem Sprung zu einzelnen Kommentar-Ankern).
- Reddit-artiger, beliebig tief verschachtelter Kommentarbaum mit Soft-Delete.

## Architektur

```
Browser (PWA)  ──POST {action,payload,auth}──►  Apps Script Web-App  ──►  Google Sheet (4 Tabs)
   app.js          text/plain (kein CORS-Preflight)     Code.gs              users/cards/comments/spaces
                ──GET ?r=cards&ns=&token= ─────────►  (REST Read-API)    + Drive-Ordner (Bilder)
```

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | App-Shell (Sidebar + Main), CDN-Libs, SW-Registrierung |
| `app.js` | Router, State, API-Client, alle Views, Kommentarbaum |
| `style.css` | Designsystem (monochrom Weiß/Schwarz, Inter, Slack-Layout) |
| `manifest.webmanifest`, `sw.js` | PWA (installierbar, App-Shell offline) |
| `icons/192.png`, `icons/512.png` | App-Icons |
| `backend/Code.gs` | **Referenzkopie** des Apps-Script-Backends (siehe unten) |

## Live

- **App:** https://techmanufaktur-io.github.io/tm-public-cards/
- **API (`/exec`):** in `app.js` als `API_URL` hinterlegt.

## Backend-Deploy / Redeploy

Das Backend liegt im Apps-Script-Projekt, das an die Spreadsheet `Public-Cards-DB` gebunden ist (Sheet → *Erweiterungen → Apps Script*). `backend/Code.gs` ist die versionierte Referenz.

**Erstmalige Einrichtung (bereits erfolgt):**
1. Code aus `backend/Code.gs` in den Editor einfügen, speichern.
2. Funktion **`setup()`** einmal ausführen → legt die 4 Tabs (`users`, `cards`, `comments`, `spaces`) mit den exakten Headern an und erstellt einen Drive-Ordner für Bild-Uploads; dessen ID wird in den **Script Properties** (`DRIVE_FOLDER_ID`) gespeichert (keine Konstante manuell editieren nötig).
3. **Bereitstellen → Neue Bereitstellung → Web-App**, *Ausführen als: Ich*, *Zugriff: Jeder* → `/exec`-URL kopieren und in `app.js` als `API_URL` eintragen.

**Code ändern & neu deployen (URL bleibt stabil):**
1. `backend/Code.gs` anpassen, in den Editor übernehmen, speichern.
2. **Bereitstellen → Bereitstellungen verwalten →** bestehende Bereitstellung *Bearbeiten →* Version: **Neue Version → Bereitstellen**. Die `/exec`-URL bleibt gleich.

## REST Read-API (GET)

Dasselbe Web-App liefert lesend JSON. Auth optional via `?ns=<namespace>&token=<token>` (ohne Token nur `public`).

```bash
curl "<API_URL>"                                   # Health-Check
curl "<API_URL>?r=cards"                            # öffentliche Cards
curl "<API_URL>?r=cards&ns=dapu&token=…"            # + eigene & Space-Cards
curl "<API_URL>?r=card&slug=<slug>"                 # eine Card + Kommentarbaum
curl "<API_URL>?r=comments&card=<slug|id>"          # nur Kommentarbaum
```

## Lokale Entwicklung

```bash
python3 -m http.server 8765
# http://localhost:8765/index.html
```

## Grenzen (ehrlich)

- **Kein echtes Auth.** Wer `namespace+token` hat, ist dieser Nutzer (Token nur als SHA-256-Hash im Sheet). Trust-based.
- **Drive-Bilder sind öffentlich** („Anyone with link"). Bei `private`-Cards bleibt das Bild über die Bild-URL technisch erreichbar.
- **Token in der GET-URL** der REST-API kann in Logs/History landen — Schreibvorgänge laufen daher nur über `POST` (Token im Body).
- Markdown wird **immer** mit DOMPurify saniert (XSS-Schutz).
- Keine Pagination; Apps-Script-Quotas gelten.
