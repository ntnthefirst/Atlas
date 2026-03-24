# Atlas - Volledige Functionele en Technische Documentatie

## 1. Doel van Atlas

Atlas is een desktop-app (Electron + React) voor persoonlijke of projectmatige tijdregistratie op basis van echte activiteit op je computer.

Kernidee:

- Je maakt een map (projectcontext).
- Je start een sessie voor die map.
- Atlas registreert automatisch welke app/window actief is tijdens de sessie.
- Je ziet achteraf tijdverdeling per app, sessie-overzicht, taken en visuele notities.

Primair doel:

- Inzicht krijgen in waar tijd naartoe gaat.
- Werk structureren met tasks en notes binnen dezelfde context.
- Snel schakelen tussen registratie (start/pause/stop), analyse (dashboard/logbook) en organisatie (tasks/notes).

## 2. Productoverzicht

Atlas combineert in een app:

- Time tracking per sessie.
- Automatische app-activiteitblokken tijdens sessies.
- Dashboard met dagtotalen en statistieken.
- Logbook met sessietijdlijn en appverdeling.
- Kanban-achtig task board per map.
- Vrij notebook-canvas met tekst, post-its en media.
- Instellingen voor thema en quick actions.
- Mini player venster voor actieve sessiecontrole.
- Systeemtray integratie.

## 3. Architectuur en werking (end-to-end)

### 3.1 Stack

- Renderer/UI: React 19 + TypeScript + Vite.
- Desktop shell: Electron.
- Lokale database: SQLite via `sql.js` (WASM), opgeslagen als bestand in userData.
- Styling: Tailwind + custom CSS variabelen en utility classes.
- Animatie: Framer Motion.

### 3.2 Processen

- Renderer process: alle UI, state management en interactie.
- Main process (`electron/main.cjs`): window lifecycle, IPC, tray, thema op OS-niveau, app launch commando's.
- Preload (`electron/preload.cjs`): veilige bridge (`window.atlas`) tussen renderer en main IPC.

### 3.3 Dataflow

1. UI roept `window.atlas.*` aan.
2. Preload forwardt naar IPC channel (`ipcRenderer.invoke`).
3. Main process handelt channel af (`ipcMain.handle`).
4. Main gebruikt `AtlasDatabase` en `ActivityTracker`.
5. Resultaat gaat terug naar renderer en wordt in React-state verwerkt.

### 3.4 Opslag en persistentie

- Structurele data in SQLite bestand (`atlas.db`) in Electron userData map.
- UI voorkeuren (theme, quick actions, task order/columns) in `localStorage`.

## 4. Domeinmodel (concepten)

### 4.1 Map

Een projectcontainer voor:

- Sessies
- Activiteitsblokken
- Tasks
- Notebook/note

### 4.2 Sessie

Tijdregistratie-unit met:

- Start/einde
- Actief of niet
- Gepauzeerd of niet
- Totale duur en pauzeduur

### 4.3 Activity block

Automatisch geregistreerd blok binnen een sessie:

- App/window label
- Start/einde
- Duur

Nieuw blok ontstaat wanneer actieve app verandert (en sessie actief en niet gepauzeerd is).

### 4.4 Task

Taak binnen map met:

- Titel
- Beschrijving
- Status (vrij tekstveld)

### 4.5 Notebook/note

Per map bestaat effectief 1 notebook-document (JSON in `notes.content`) met:

- Viewport (x, y, zoom)
- Nodes (text, postit, media)

## 5. Belangrijkste gebruikersflows

### 5.1 Eerste start

- Als er nog geen maps zijn, opent Atlas in welcome-mode.
- Gebruiker maakt eerste map.
- Daarna opent standaard hoofdinterface.

### 5.2 Sessiebeheer

- Start: alleen als map geselecteerd is en geen actieve sessie bestaat.
- Pause: markeert sessie als gepauzeerd en sluit open activity block.
- Resume: herstart sessie en vervolgt tracking.
- Stop: finaliseert sessie (duur/pauze), sluit open block, ververst UI.

### 5.3 Activiteittracking

- Polling (ongeveer elke 1500ms) van foreground window op Windows via PowerShell + Win32 API.
- Processes zoals `powershell`, `pwsh`, `cmd`, `windowsterminal` worden genegeerd.
- Bij app-wissel: huidig block sluiten en nieuw block openen.

### 5.4 Mapbeheer

- Maken, hernoemen, verwijderen.
- Verwijderen van map met actieve sessie in die map is geblokkeerd.
- Verwijderen cascaded gerelateerde sessies, pauses, activity_blocks, tasks, notes.

### 5.5 Mini player

- Los always-on-top venster met timer + pause/resume + stop + close.
- Kan dynamisch resizen op basis van content.
- Bedoeld voor snelle controle zonder hoofdvenster.

### 5.6 Tray gedrag

- Bij sluiten hoofdvenster tijdens actieve sessie: app verbergt naar tray.
- Tray menu: show app, open mini, quit.

## 6. UI-structuur en functies per view

### 6.1 Header

Functies:

- App branding + titlebar.
- Map switcher/menu.
- Opname controls:
    - Start recording
    - Pause/resume
    - Stop
    - Open mini player

### 6.2 Sidebar

Navigatie tussen views:

- Dashboard
- Logbook
- Tasks
- Notes
- Settings

### 6.3 Dashboard

Doel:

- Dagelijkse status in een oogopslag.

Inhoud:

- Total time today.
- Quick stats: sessies vandaag, open tasks, current app, current map.
- Time per app (toplijst met balken).
- Time per map.
- Quick action knoppen (commando launch).

### 6.4 Logbook

Doel:

- Analyse van sessies en appgebruik.

Inhoud:

- Linker kolom: sessielijst met status en duur.
- Rechter kolom: timeline rail + appverdeling binnen geselecteerde sessie.
- Appkleurcodering met bekende mapping en fallback palette.

### 6.5 Tasks

Doel:

- Visueel taakbeheer per map.

Eigenschappen:

- Dynamische kolommen met vrije statusnamen.
- Kolom hernoemen (double click), toevoegen, verwijderen.
- Drag-and-drop:
    - Taak binnen kolom herschikken.
    - Taak naar andere kolom verplaatsen.
    - Kolommen onderling herschikken.
- Nieuwe taak direct in gekozen kolom.

Persistente UI-instellingen:

- Volgorde task ids per map: `atlas.taskOrderByMap`.
- Kolomdefinities per map: `atlas.taskColumnsByMap`.

### 6.6 Notes (Notebook canvas)

Doel:

- Vrije visuele notities en media per map.

Node types:

- `text`
- `postit`
- `media` (image/video/audio)

Functionaliteit:

- Nodes toevoegen (text, postit, media upload).
- Selectie, edit, drag, resize (niet voor text).
- Zoom en pan canvas (muis + touch gestures).
- Keyboard shortcuts voor bewegen, verwijderen, dupliceren, zoom reset.
- Copy/paste van nodes, tekst, en media uit clipboard.
- Tekstkleur, boxkleur (post-it), fontgrootte.
- Autosave met debounce (ongeveer 450ms) naar database.

### 6.7 Settings

Huidige functies:

- Theme mode: light/dark/system.
- Simpele UI toggles/selects voor voorkeuren (lokaal component-state).
- Quick actions beheren:
    - Label + command toevoegen.
    - Verwijderen.

Quick actions worden opgeslagen in `localStorage` onder `atlas.quickActions`.

## 7. Electron venstermodes

### 7.1 Main window

- Volledige Atlas interface.
- Custom titlebar gedrag per platform.

### 7.2 Welcome window

- Compact onboarding venster voor eerste map.

### 7.3 Mini window

- Kleine bediening voor actieve sessie.
- Transparant, frameless, always-on-top.

## 8. IPC/API contract (`window.atlas`)

Map:

- `listMaps()`
- `createMap(name)`
- `renameMap(mapId, name)`
- `deleteMap(mapId)`

Sessie:

- `getActiveSession()`
- `startSession(mapId)`
- `pauseSession(sessionId)`
- `resumeSession(sessionId)`
- `stopSession(sessionId)`
- `listSessionsByMap(mapId)`

Activiteit:

- `listActivityBySession(sessionId)`
- `getCurrentApp()`

Tasks:

- `listTasksByMap(mapId)`
- `createTask(mapId, title, description?)`
- `updateTaskStatus(taskId, status)`

Notes/Notebook:

- `listNotesByMap(mapId)`
- `createNote(mapId, content?)`
- `updateNote(noteId, content)`
- `deleteNote(noteId)`
- `getNotebookByMap(mapId)`
- `updateNotebookByMap(mapId, content)`

Dashboard:

- `getDashboardOverview(mapId)`

App/Window:

- `launchApp(command)`
- `getPlatform()`
- `setNativeTheme(theme)`
- `windowMinimize()`
- `openMiniWindow()`
- `resizeMiniWindow(width, height)`
- `showMainWindow()`
- `closeMiniWindow()`
- `windowToggleMaximize()`
- `windowClose()`

## 9. Database details

### 9.1 Tabellen

- `maps`
    - id, name, created_at
- `sessions`
    - id, map_id, started_at, ended_at, total_duration, paused_duration, is_active, is_paused, pause_started_at, created_at
- `pauses`
    - id, session_id, started_at, ended_at
- `activity_blocks`
    - id, session_id, app_name, started_at, ended_at, duration
- `tasks`
    - id, map_id, title, description, status, created_at, updated_at
- `notes`
    - id, map_id, content, created_at, updated_at

### 9.2 Belangrijke datalogica

- Slechts 1 actieve sessie tegelijk.
- Pauzes worden expliciet gelogd in `pauses`.
- Bij stoppen sessie worden open pauses en open activity block afgerond.
- Dashboard berekent live tijden voor actieve sessies.

## 10. Kernfuncties in code (overzicht)

### 10.1 `electron/main.cjs`

Verantwoordelijk voor:

- Window creatie/close gedrag.
- Theme sync met OS/native titlebar.
- Tray setup.
- IPC handlers en validatie.
- Starten database en tracker bij `app.whenReady()`.

### 10.2 `electron/db.cjs` (`AtlasDatabase`)

Belangrijkste methodes:

- Schema init en persist (`initSchema`, `persist`, `run`).
- Map lifecycle (`listMaps`, `createMap`, `renameMap`, `deleteMap`).
- Session lifecycle (`startSession`, `pauseSession`, `resumeSession`, `stopSession`).
- Activity blocks (`createActivityBlock`, `getOpenActivityBlock`, `closeOpenActivityBlock`).
- Tasks (`listTasksByMap`, `createTask`, `updateTaskStatus`).
- Notes/notebook (`getNotebookByMap`, `updateNotebookByMap`, etc).
- Dashboard aggregaties (`getDashboardOverview`).

### 10.3 `electron/activity-tracker.cjs` (`ActivityTracker`)

Belangrijkste methodes:

- `start`, `stop`
- `setCurrentSession`, `clearCurrentSession`
- `getForegroundAppInfo` (Windows)
- `tick` (poll + block update)
- `closeOpenBlockNow`

### 10.4 `src/App.tsx`

Regelt:

- Centrale appstate en bootstrapping.
- Polling loops voor sessie/app/dashboard updates.
- Navigatie tussen views.
- Actions voor maps, sessies, tasks, notebook, quick actions.
- Rendering voor mini/welcome/main mode.

## 11. Thema en styling

- Themas: `light`, `dark`, `system`.
- CSS variabelen voor kleur/typografie.
- Tailwind config mapt design tokens op CSS variabelen.
- `setNativeTheme` synchroniseert titlebar op Windows.

## 12. Commando's (development en distributie)

Belangrijke npm scripts:

- `npm run dev` - renderer + electron tegelijk.
- `npm run start` - electron run.
- `npm run build` - typescript build + vite build.
- `npm run dist` - windows installer build (NSIS).
- `npm run dist:portable` - portable windows build.
- `npm run lint` - ESLint.

## 13. Platform details en beperkingen

- Activiteittracking is gericht op Windows (foreground window via PowerShell script).
- Niet-Windows krijgt fallback `Unknown` app info.
- Tracker negeert shell/processen zoals powershell/cmd om ruis te beperken.
- UI bevat meertalige labels (deels NL, deels EN) en kan nog gestandaardiseerd worden.

## 14. Bekende ontwerpkeuzes

- `sql.js` (WASM) in plaats van native sqlite module:
    - Minder afhankelijkheid van lokale C++ build tools.
    - Eenvoudigere distributie voor huidige setup.
- Notes model gebruikt 1 notebook-document per map in `notes` tabel.
- Task statuses zijn open tekstwaarden voor flexibiliteit.

## 15. Mogelijke uitbreidingen

- Multi-user sync (cloud backend).
- Export rapportages (CSV/PDF).
- Geavanceerde task metadata (prioriteit, due date, assignee).
- Filters/search in logbook en notes.
- Platform-specifieke foreground tracking voor macOS/Linux.
- Uniforme taal in UI (volledig NL of volledig EN).

## 16. Samenvatting in 1 alinea

Atlas is een lokale desktop productivity tracker die tijdregistratie, automatische app-activiteitsmeting, taakbeheer en visuele notities per project-map samenbrengt. De app draait op Electron met een React-frontend, gebruikt een lokale SQLite database via `sql.js`, exposeert alle domeinacties via een veilige `window.atlas` bridge, en biedt meerdere gebruiksmodi (welcome, main, mini/tray) om zowel registratie als analyse snel en contextgericht te maken.
