# Saajha / Soochna Setu — Community Multilingual Noticeboard

A lightweight university web development project using the original HTML, CSS and vanilla JavaScript interface, now backed by Flask and SQLite. No frontend framework or build step is required.

## Run on Windows

Install Python 3.10 or newer. In this project folder, run:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m flask --app app create-user admin
.\.venv\Scripts\python.exe app.py
```

The account command asks for a password twice (at least 10 characters). There is no default password. Open **http://127.0.0.1:5000** in your browser. Do not open index.html directly or use Live Server: the application requires its Flask APIs. If `py` is unavailable, use `python` or your installed Python executable for the first command.

For macOS/Linux, use `python3 -m venv .venv` and `.venv/bin/python` in place of the Windows executable.

Optional reviewer account:

```powershell
.\.venv\Scripts\python.exe -m flask --app app create-user reviewer --role reviewer
```

The SQLite file `database/notices.db` and all tables are created automatically. Notices persist after refresh and server restart. Keep this file when moving or backing up the project.

## Optional original sample notices

A new installation has categories but no notices. To load the original project's eight fictional notices into an empty database:

```powershell
.\.venv\Scripts\python.exe -m flask --app app seed-demo
```

This imports the preserved examples from sample_data.json. Dates are relative to the day the command runs and remain fixed afterward. Existing records are never overwritten. Included Hindi and Punjabi translations start as **pending**, not automatically approved. These examples are clearly fictional and are not real public advisories.

## Main workflows

- Residents browse published notices, search title/content/region/category/language, choose a reading language, filter category, region, publication date, language availability, priority and expiry, and sort results. Pinned notices remain first.
- Active notices are shown by default. Choose All statuses or Expired, or use Archive, to view older announcements. Expiry is inclusive through the expiry date in India Standard Time; notices are expired the following day. Future publications remain private until their publication date.
- Administrators sign in through Admin space, create a draft, preview it without losing input, edit, publish, withdraw, archive or delete it. Pinning and urgent/critical priority are separate fields. Only previously published notices can be manually archived.
- Administrators and reviewers enter translations manually. Pending versions may be incomplete. Completing a version requires title, description, action and a review confirmation. Mark unavailable removes that language version's public availability. The original remains readable.
- Changing a source notice invalidates its translations. The server rejects edits based on an outdated source version; reopen the editor to load the latest version.
- Completed language versions are shown when readers select that language. Original text is available inside the notice details. English, Hindi and Punjabi can each be the original language.
- Bookmarks, preferred language and text size are browser preferences; only those preferences use localStorage. Reset reading preferences does not erase server data.
- Export JSON includes the workspace's notices, translations, categories and activity. It is an export, not an automatic database backup or import facility.

## Files and responsibilities

| File | Responsibility |
| --- | --- |
| index.html | Existing public board, navigation, workspace and shared dialog |
| style.css | Preserved green/cream identity, improved typography, state indicators and responsive layouts |
| app.js | Rendering, filtering, accessible interactions and fetch requests |
| translations.js | English, Hindi and Punjabi interface wording extracted from app.js |
| app.py | Flask routes, authentication, permissions, input validation and account/seed commands |
| database.py | SQLite connection lifecycle, schema, categories and reading relational notice records |
| sample_data.json | Original fictional notices, available only through an explicit seed command |
| requirements.txt | Flask dependency; SQLite is included with Python |
| test_app.py | Backend integration tests using isolated temporary databases |
| TESTING.md | Actual verification performed and its limits |

The original four files were modified; the others were added. No original project files were removed. The existing markup, styling, rendering helpers, routing, preview, bookmarks, categories, export and translation-review workflows were retained and adapted.

## Database design

- **users**: username, password hash and admin/reviewer role.
- **categories**: category ID, unique name, translated labels and icon.
- **notices**: title, body (description), action, issuer, location (region), category foreign key, original language, publication/expiry dates, urgent/critical/highlighted flags, publication status and source version.
- **translations**: composite key of notice ID and language, translated title/body/action, pending/completed/unavailable status, source version and reviewer metadata. Deleting a notice cascades to its translations.
- **activity**: server-generated publishing and translation events, including actor and timestamp.

Queries use bound parameters. The small set of dynamically assembled column names comes only from server-defined fields. Public API responses exclude drafts, withdrawn/scheduled notices and unfinished translation text. Workspace data requires authentication.

## API overview

- GET /api/session, POST /api/login, POST /api/logout
- GET /api/notices (q, category, location, original_language, language, priority, state)
- POST /api/notices, PUT or DELETE /api/notices/<id>
- PATCH /api/notices/<id>/status
- PUT /api/notices/<id>/translations/<language>
- GET /api/categories, POST /api/categories
- GET /api/workspace

Writes require a signed-in authorised account and the session's X-CSRF-Token. Login also requires the token returned by GET /api/session. Passwords are hashed; sessions use HTTP-only, SameSite cookies. Static routes expose only the intended frontend files, not the database or source backend files.

## Tests

```powershell
.\.venv\Scripts\python.exe -m unittest -v test_app
node --check app.js
node --check translations.js
```

Node is only needed for the optional JavaScript syntax checks. It is not an application dependency.

## Limitations and handover notes

- Translation is manual. Completing a translation records a review decision; it does not certify linguistic accuracy. Admin forms, some new filter/status labels and the About dialog are in English.
- The app is intended for local academic demonstration. Before internet deployment, add HTTPS, production hosting, login rate limiting, account recovery and an operational backup policy. The bundled Flask development server is not a production server.
- The default session signing key is regenerated on restart, so users sign in again. Set the SECRET_KEY environment variable to a private, stable random value if persistent sessions are needed. Never commit it.
- There is no attachment upload or live translation API; the original project had neither. Shared records refresh every minute when no editor is open.
- Existing data in the previous frontend-only application's browser storage is not automatically imported. The original Desktop files were backed up before updating. Existing browser data is left untouched.
- See TESTING.md for the sandbox's localhost limitation. Network-level serving should be checked once on your own computer.

