# Work OS: UI inventory (navigation input)

Measured from the code at commit `90f76fa` (master). Read-only pass, nothing in the app was changed.
Method: static read of `app/`, `components/`, `components/mobile/` and `docs/HANDOVER.md`. The app was **not run**: `.env.local` points at Atlas, so a local run needs a rebuilt throwaway setup. Anything that depends on pixel widths is marked *(est.)*.
Taps/clicks are counted from the landing page `/today` (`/` redirects there). "Phone" = below 768 px (390 px checked in code, not on screen).

Surface switching is by CSS (`md:hidden` / `hidden md:block`), so most routes are one URL with two layouts. Where they differ it is noted.

---

## 1. Surfaces

### 1.1 Routes (signed-in app, `app/(app)/`)

| # | Route | Desktop | Phone | Notes |
|---|---|---|---|---|
| 1 | `/today` | yes | yes | landing page |
| 2 | `/board` (labelled "Tasks") | board columns | list with 4 segments | route name and label differ |
| 3 | `/tasks/[id]` | yes | yes (separate component) | |
| 4 | `/projects` | yes | yes | no direct link on phone (see 2.4) |
| 5 | `/projects/[id]` | yes | yes | holds 7 sections (see 1.4) |
| 6 | `/notes` | yes | yes | |
| 7 | `/notes/[id]` | yes | yes | nests via sub-pages, no depth limit |
| 8 | `/history` | yes | yes | 4 tabs |
| 9 | `/hidden` (labelled "Untouched") | yes | yes | |
| 10 | `/review` (labelled "Weekly review") | yes | yes | |
| 11 | `/timetable` | yes | yes | phone shows one day via `?day=` |
| 12 | `/recovery` | yes | yes | static text page |
| 13 | `/notifications` | yes | yes | |
| 14 | `/settings` | yes | yes | 4 groups on one page |
| 15 | `/connect` | yes | yes | 7 tabs |
| 16 | `/modes/[mode]` | 8 pages | 8 pages | one template, 8 instances |
| 17 | `/more` | URL only, no link | yes (tab) | phone-only in practice |
| - | `/archive` | redirect | redirect | to `/history?tab=archived`; nothing links to it |

Outside the app: `/` (redirect), `/login`, `/login/reset`, offline page. Not counted below.

**Count:** 17 real signed-in routes (+1 redirect). With 8 mode instances that is **24 distinct pages**.
Desktop reaches 16 of the 17 from the sidebar; phone reaches 4 from the tab bar, 13 from More, 1 only from other pages (`/projects`).

### 1.2 Tabs and states inside a page (own URL or own state)

| Page | Tabs / states | Count | In URL? |
|---|---|---|---|
| `/connect` | Overview, Claude chat, Claude Code, Devices, Discord, Alerts, Reference | 7 | `?tab=` (push, not replace) |
| `/history` | Completed, Activity (+5 actor filters), Archived, Trash | 4 (+5) | `?tab=` `?actor=` (replace) |
| `/board` phone | Open, Due soon, Waiting, Done | 4 | state only |
| `/board` filters | project, mode, due (6 values), search | 4 | `?project&mode&due&q` |
| `/notes` | state (3), kind (3), project, search | 4 axes | URL |
| `/timetable` phone | Mon-Fri | 5 | `?day=` |
| `/projects` | Active / All | 2 | `?all=1` |
| `/modes/[mode]` | Active / All / Done | 3 | **component state only** (lost on back) |
| Settings | This device, Notifications, Security, App | 4 groups | one scroll |

### 1.3 Sheets, dialogs and popovers that act as their own screen

| Kind | Desktop | Phone | Names |
|---|---|---|---|
| Create flows | 6 dialogs | 5 sheets | Quick add (N), New task form (Shift+Enter), New project, New weekly review, New note (inline select), Import. Phone: Quick add, New project (full sheet), New note, Import; Weekly review is still a centered dialog on phone |
| Task edit | 1 dialog (Log progress) | 6 sheets + 1 menu | Phone: Estimate, Tags, Blocked because, Add link, Waits on, Delete; plus the ⋯ popover (Drop, Reopen, Archive, Delete) |
| Task row actions | none (inline selects) | 1 sheet | Row ⋯ or long-press: status, priority, due, mode, Open task |
| Filters | none (inline selects) | 1 sheet | Tasks Filters |
| Today extras | Day Plan, Import dialogs | Day plan, Import sheets | |
| Comment menu | hover Edit/Delete | 1 sheet (+ delete confirm) | |
| Delete confirms | Delete task, Delete forever (dialogs) | Delete task reason sheet | |
| Claude item detail | 1 dialog | 1 sheet | opens from the work list |
| Sessions | Start dialog, Add folder dialog | 2 sheets | |
| Devices / keys | key reveal panel, `window.confirm` revoke | 2 sheets each | |
| Native `confirm()` | 5 | 0-1 | note delete, passkey remove, device revoke, key revoke/rotate |

**Count:** about **16 dialog/sheet screens on desktop** and **about 24 on phone** (phone splits every edit into its own sheet).
Security (passkey add, authenticator setup, change password, recovery codes) works as inline modes inside the Settings card, not as dialogs.

### 1.4 Sections inside a page that work as a separate area

| Page | Areas | Count |
|---|---|---|
| `/projects/[id]` | header/details, stats, Open, Recently finished, Claude's work list (only if items exist), Sessions, Notes, Code locations, Activity | **9** |
| `/tasks/[id]` | details, progress, checklist, description, links, dependencies, comments, note card, history | 9 |
| `/today` | stats, schedule/"NOW" block, Overdue, Due today, In progress, Blocked, Up next, Also open, Routine (Fiverr ritual) | 9-10 |
| `/connect` | each tab has 2-4 `Section`s plus 1-4 collapsed `Disclosure`s | about 30 areas in total |
| `/settings` | 4 groups, 10+ rows | 4 |

---

## 2. Navigation

### 2.1 Desktop sidebar (all 23 controls, always visible)

| Group | Items | Count |
|---|---|---|
| Action | New task (N) | 1 |
| Main | Today (badge), Tasks, Projects, Notes, History & trash | 5 |
| Modes | 8 mode links | 8 |
| Other | Untouched (badge), Weekly review, Timetable, Recovery, Notifications (badge), Settings, Connect | 7 |
| Footer | theme toggle, sign out | 2 |

= 20 links + 3 controls. No top bar. A fixed bottom bar (`CurrentBlockBar`, 40 px) shows the current time block. No back buttons on desktop except on the note page ("Notes", parent).

### 2.2 Phone bottom bar and More

Bar: Today, Tasks, **+** (quick add), Notes, More = **5 slots, 4 destinations + 1 action**. Bell sits in every `MobileHeader` (Today, Tasks, Notes, More and every sub-page except Notifications).

More page = **17 fixed rows + up to 30 project rows = up to 47 rows**:

| Group | Rows |
|---|---|
| Projects | up to 30 + "All projects" |
| Modes | 8 |
| Work | History & trash, Untouched, Weekly review, Timetable, Recovery, Notifications (6) |
| Settings | Settings, Connect (2) |

Tab highlight rules (`tab-bar.tsx`): `/projects` and `/tasks` light **Tasks**; `/notes` lights **Notes**; 11 other prefixes light **More**.

### 2.3 Taps/clicks from `/today` to every surface

| Surface | Phone | Phone path | Desktop | Desktop path |
|---|---|---|---|---|
| Tasks list | 1 | Tasks tab | 1 | sidebar |
| Notes list | 1 | Notes tab | 1 | sidebar |
| Notifications | 1 | bell | 1 | sidebar |
| Quick add | 1 | + | 1 (or key N) | sidebar button / N |
| Day plan, Import, Flex toggle | 1 | Today buttons | 1 | Today buttons |
| Task detail | 1 | row on Today | 1 | row title |
| Task: edit estimate/tags/blocked/link/dep | 3 | row, field, save | 1 (inline) | edit in page |
| Task: delete | 4 | row, ⋯, Delete, confirm | 3 | task, Delete, confirm |
| Task: row quick actions | 1 (⋯ or long-press) | | n/a | inline selects |
| More | 1 | tab | n/a | |
| A project (top 30) | 2 | More, project | 2 | Projects, project |
| Projects list (active only) | no direct path | only via Back from a project, or More, All projects (2, shows all) | 1 | sidebar |
| Project note | 3 | More, project, note | 3 | |
| Claude work item | 3+ | More, project, scroll, item | 3+ | |
| Start a session | 4-5 | More, project, Start, confirm | 4-5 | |
| A mode page | 2 | More, mode | 1 | sidebar |
| History & trash (Completed) | 2 | More, History | 1 | sidebar |
| History: Activity / Archived / Trash | 3 | + tab | 2 | |
| Restore from trash | 4 | + Restore | 3 | |
| Un-archive a task | 6 | More, History, Archived, task, ⋯, Unarchive | 4 | History, Archived, task, Restore |
| Untouched / Review / Timetable / Recovery | 2 | More | 1 | sidebar |
| Settings | 2 | More | 1 | sidebar |
| Settings: Security actions (passkey, TOTP, password) | 3 | + action | 2 | |
| Connect Overview | 2 | More | 1 | sidebar |
| Connect: Claude chat / Claude Code / Devices / Discord / Alerts / Reference | 3 | More, Connect, tab | 2 | |
| Create a Claude Code key / device | 3 (+ sheet) | | 2 (+ panel) | |
| Discord blocked channels | 3, then scroll | | 2 | |
| Sub-page of a note | 3+ | Notes, note, sub-page, ... | 2+ | |

**Averages from `/today`:** desktop = 1 for 21 of 24 main pages, 2 for Connect tabs. Phone = 1 for 4, 2 for 14, 3 for 7 (Connect tabs, History tabs, Security).

### 2.4 Surfaces reachable from more than one place

| Surface | Entry points | Count |
|---|---|---|
| Notifications | bell on 5+ phone headers, More row, desktop sidebar, Settings gear on the page itself | 4 kinds |
| Settings | More, sidebar, Notifications gear, Connect > Alerts "Preferences" | 4 |
| Connect | More, sidebar, Settings x2 (both rows go to the same page: "System status" and "Claude, Discord & alerts setup") | 4 |
| Connect > Devices | tab, Overview card, project Sessions link | 3 |
| `/board` | tab/sidebar, Today stats (6 links, 3 with filters), Today "N more open" | 10+ |
| History | sidebar/More, Today stats "completed" tile | 3 |
| Projects | More list, More "All projects", sidebar, notes breadcrumbs, task project link, tab highlight | 6 |
| Recovery | More/sidebar, Today flex-day banner (phone and desktop) | 3 |
| Tasks created | N, sidebar button, + tab, Today bar, project bar, mode bar, project Add, form, Import | 9 entry points |
| Mode filter | 8 mode pages, Board mode select, Tasks Filters sheet, Recovery "Mode Definitions" list, More modes, sidebar modes | same filter in 4 UIs |

### 2.5 Surfaces reachable only through deep links or buried paths

| Surface | How | Issue |
|---|---|---|
| `/projects/[id]?claude=Cn` (opens Claude item) | inbox notification only | the only direct link |
| Claude's work list | exists only when Claude has added items; cannot be created from the UI | invisible until used, 3 taps deep |
| Sessions, Code locations, Folder linking | project page bottom half (phone: scroll) | Claude Code setup spans 3 places (see 5.3) |
| `/projects` Active list on phone | back from a project | no row for it |
| `/archive` | nothing links to it | redirect only |
| `/more` on desktop | URL only | not linked |
| Row task actions on phone | long-press (450 ms) or the small ⋯ | gesture is undiscoverable; ⋯ is the fallback |
| Connect tabs Reference, Alerts (and probably Discord) on 390 px | horizontal scroll strip, 7 tabs, about 100-125 px each *(est.)*, roughly 2x screen width | off-screen tabs need a swipe |
| Security (passkeys, TOTP, password) | Settings, third group | 3 taps, no entry from the login page flow |
| Note sub-pages | `/` menu inside a note | unlimited depth, back goes one level |

### 2.6 Back-navigation oddities

1. **Two back models on phone.** Task detail uses `router.back()` (falls back to Today). Sub-pages use a fixed label ("More", "Projects", "Today"). Notes use parent-aware back.
2. **Notifications** is opened from the bell (any tab) *and* from More, but Back always says "Today". Its tab highlight is More.
3. **Settings** reached from the Notifications gear: Back goes to More, not Notifications. Same from Connect > Alerts > "Settings".
4. **Project page** Back is fixed to "Projects", whatever was before (a note breadcrumb, a task, More). Projects is reached from More, whose list is the real entry, so Back lands on a page that has no row in More.
5. **Tab highlight vs origin.** `/tasks/[id]` lights Tasks even when opened from Today or Notes. `/projects*` lights Tasks although reached from More.
6. **Connect tabs push history** (`Link`, no `replace`). History tabs and Timetable use `replace`. So system Back in Connect steps through every tab visited; in History it leaves the page.
7. **Board filters push** (`router.push` for most filter changes); Notes filters replace.
8. **State not in URL:** `/modes/[mode]` Active/All/Done, Board phone segment (Open/Due soon/Waiting/Done), Flex day (localStorage).
9. **Desktop has no back control** on task, project or settings pages; relies on the sidebar.

---

## 3. Entities

Legend: V view, C create, E edit, D delete. "Surfaces" = distinct screens/sheets where it appears.

| Entity | View | Create | Edit | Delete | Surfaces | Notes |
|---|---|---|---|---|---|---|
| **Task** | Today, Tasks/Board, Project, Mode (x8), Untouched, History (Completed, Archived, Trash, Activity), Notes (link), Notifications, Claude via MCP | 9 entry points (2.4) | task page (desktop inline, phone 6 sheets + inline), row ⋯ sheet, board drag (status) | task page Delete (trash 30 days with Undo); purge in Trash | **16+** | richest entity, 5 list renderers |
| **Project** | Projects, More list, project page, Board/Notes filters, task chip, Notes breadcrumbs | New project (dialog/sheet) | project page header, status select | **no delete**, status only (active, paused, done...) | 7 | |
| **Note** | Notes, note page, project aside, task page card, Today/row icon, `@` mentions | New note (list, project, task) and `/` sub-page | note page | note page (confirm, trash 30 days) | 7 | archive is a separate state |
| **Claude item** | project page only (+ More badge "N for you", Projects badge) | **MCP only** | state, kind, next, order, reply note (dialog/sheet) | **none** | 3 | |
| **Session** (Claude Code) | project page Sessions | Start (dialog/sheet) | Resume, Stop | none | 1 | |
| **Folder link** | project page Sessions | Add folder, Link suggestion | n/a | Unlink | 1 | |
| **Code location** | project page | inline add | inline | inline remove | 1 | also settable via MCP |
| **Device** (worker) | Connect > Devices, Overview card, project link | add (key shown once) | none (no rename) | Revoke | 3 | |
| **Claude Code key** | Connect > Claude Code | create | Rotate | Revoke | 2 | |
| **Claude chat connector** (token) | Connect > Claude chat, Reference | env var only | env var | n/a | 3 | key shown/hidden in UI |
| **Discord** (channel blocklist, status) | Connect > Discord, Overview card, Status | n/a | Save blocked channels | n/a | 2 | |
| **Notification (inbox item)** | Notifications, bell badge, sidebar badge | system | mark all read (automatic on open) | none (kept 60 days) | 3 | |
| **Alert rule / pref** | Settings > Notifications, Connect > Alerts (read-only status and rules) | n/a | Settings switches (8 kinds, 2 channels), per-device push | n/a | 2 | split view/edit |
| **Alert run / status** | Connect > Alerts, Overview | system | n/a | n/a | 2 | |
| **Passkey / TOTP / password** | Settings > Security | inline | inline | inline remove | 1 | |
| **Weekly review** | Review | New review dialog | inline | none | 1 | |
| **Ritual log (Fiverr)** | Today "Routine" | inline | n/a | n/a | 1 | |
| **Comment** | Task history (all lists of activity) | task page | edit | delete | 4 | any comment |
| **Checklist item** | task page, row counter | inline | toggle | remove | 2 | |
| **Schedule / time block** | Today "NOW", Day plan, Timetable, bottom bar, Recovery | n/a (code-defined) | n/a | n/a | 5 | not editable |
| **Mode** | sidebar/More, mode pages, Recovery definitions, pickers | n/a (code-defined) | n/a | n/a | 6+ | |
| **Trash item** | History > Trash, trashed task page | via delete | Restore | Delete forever | 2 | |
| **Appearance, install, push device** | Settings | n/a | switches | n/a | 1 | |

---

## 4. Features and interactions

| Feature | Desktop | Phone | Gap |
|---|---|---|---|
| Quick add (one-line syntax) | N, sidebar, 3 inline bars (Today, Project, Mode) | + tab; inline bars on Project and Mode too | phone bar has chips (due, priority, project) but no mode, tags or estimate chip (typed syntax only); "Add & open" phone-only |
| Full task form | Shift+Enter | none | phone has no form, only chips + task page |
| Task search | Board `q`, Notes search | Tasks search (live), Notes search (live) | no global search anywhere |
| Filters | Board: project, mode, due, search (selects) | Filters sheet: project, mode, due; project chips | parity |
| Notes filters | state, kind, project, search (form with Filter button) | chips for state, kind, projects, live search | desktop needs a button press |
| Drag | Board columns change status; note blocks reorder | note blocks only | status changes on phone via sheet |
| Swipe | none | none (only scrollable chips) | long-press 450 ms on rows is the only gesture |
| Long-press | none | row opens actions sheet | phone-only |
| Hover actions | comment Edit/Delete | none (menu sheet instead) | |
| Bulk edit / multi-select | **none** (only bulk **create** via Import, both) | none | not present |
| Keyboard | N (quick add), Esc, Enter / Shift+Enter, Ctrl+Enter (comment, progress), Ctrl+S (notes), `/` and `@` in notes | Esc closes sheets | only 1 global shortcut |
| Complete a task | circle on row, task page | circle on row, sticky "Mark done" bar | parity |
| Log progress | Progress dialog | progress control on task page | |
| Undo | toasts on complete, delete, note delete | same | parity |
| Pull to refresh | n/a | all screens | |
| Import (markdown/JSON) | Today dialog | Today sheet | parity, Today only |
| Day plan | Today dialog | Today sheet | parity |
| Flex day toggle | Today | Today | per-browser (localStorage) |
| Notifications | sidebar badge | bell badge in 5+ headers | |
| Push, install | Settings | Settings | |
| Theme | sidebar footer toggle + Settings > App | Settings > App only | phone one row deeper |
| Sign out | sidebar footer + Settings | Settings only | |
| Weekly review dialog | dialog | still a dialog on phone (every other create is a sheet) | style gap |
| Native `confirm()` | note delete, passkey remove, device revoke, key revoke | keys/devices use sheets; note delete and passkey use native confirm | mixed |

---

## 5. Findings (ranked by impact)

### 5.1 Connect is a second Settings with 7 tabs, 3 deep on phone
- 7 tabs, about 30 areas, and it holds Claude chat, Claude Code, Devices, Discord, Alerts, Reference, plus a status Overview that duplicates 4 of the tabs as cards.
- 3 taps on phone (More, Connect, tab), 2 on desktop. Tab strip scrolls on 390 px.
- Its Alerts tab sends you back to Settings for the actual switches (Settings, Connect, Settings loop).
- Suggests: fold Connect into Settings as sections, or give Claude/Discord/Alerts one place with status and switches together.

### 5.2 Claude Code lives in three places
- Keys in Connect > Claude Code; Devices in Connect > Devices; Work list, Sessions, Code locations on each project page; "Connect > Devices" link inside the project page.
- Claude's work list is hidden until items exist and cannot be created or deleted in the UI.
- 3 surfaces, 4 entry names ("Claude Code", "Devices", "Sessions", "Claude's work list"), 3 taps from `/today`.
- Suggests: one "Claude" area (keys, devices, work, sessions) and a project-scoped tab inside the project.

### 5.3 Settings-like things in 4 places
- Settings (4 groups), Connect (7 tabs), More (Notifications, History, Recovery are not settings but sit beside Settings and Connect), and Theme/Sign out duplicated in the sidebar footer.
- Notification control is split across 4 surfaces: Notifications (inbox), Settings > Notifications (switches), Connect > Alerts (status and rules), per-device push on Settings > This device.
- Two Settings rows both open `/connect`; one is labelled "System status" but lands on Overview, not status.
- Suggests: one "Notifications" home (inbox, switches, status) and one "System" page.

### 5.4 Phone More is a 47-row catch-all, and 8 rarely-used items take top-level slots
- More = 17 fixed rows + up to 30 projects. Projects are listed there (the most frequent thing after tasks), but the Projects page has no row on phone.
- Top-level desktop items rarely needed or reference-only: Recovery (static text), Timetable (static), Weekly review, Untouched, plus the 8 mode links (8 of 20 sidebar links). All 20 sidebar links sit at equal weight.
- Frequent but buried on phone: Projects (2 taps), Notifications (bell, 1), History/Archive/Trash restore (4-6 taps), Settings (2), task field edits (3 taps).
- Suggests: promote Projects to a tab or a More header; collapse Recovery/Timetable/Review into one "Routine" area; put modes behind a single filter.

### 5.5 Deepest items
1. Un-archive a task on phone: **6 taps** (More, History, Archived, task, ⋯, Unarchive).
2. Restore from trash (phone): 4; delete a task (phone): 4; edit a task estimate/tags/link on phone: 3 and each opens its own sheet (6 sheets).
3. Claude item reply or reorder: 3 + dialog; start a session: 4-5.
4. Security (add passkey, TOTP, change password): 3 on phone, behind another 2 inline steps.
5. Note sub-pages: unlimited depth.
- Suggests: Archive and Trash as filters on Tasks, and Unarchive/Restore in the row ⋯ sheet.

### 5.6 The same thing in several places
| Duplicate | Count |
|---|---|
| Create task paths | 9 |
| Mode as navigation + filter + page | 4 UIs, 8 mode pages that are Tasks with `mode=` plus a description |
| Schedule (Day plan dialog, Timetable page, Today Schedule/NOW block, bottom bar, Recovery) | 5 |
| Notifications (inbox, bell, switches, status, push) | 5 |
| Settings to Connect links | 2 (same target) |
| Today stats tiles vs `/board?due=` | 6 vs 4 filters |
| Task list renderers (TaskRow, MTaskRow, board Card, ...) | 3 |
| Theme/sign out | 2 places on desktop |
| Archive (History tab, `/archive` redirect, task Archive button, note archive) | 4 meanings |
- Suggests: pick one entry per concept and route the rest to it; modes become a filter chip on Tasks.

### 5.7 Back navigation is inconsistent (see 2.6)
- 3 back models, wrong "Back" target in at least 4 flows (Notifications, Settings via gear, Project page, Connect tab history).
- Suggests: one rule (Back returns to where you came from; tab highlight follows the origin).

### 5.8 Naming inconsistencies for the same thing
| Thing | Names used |
|---|---|
| Task list | Tasks (nav), Board (route, code), Open (segment) |
| Untouched list | Untouched (label), `/hidden` (route), stale |
| Weekly review | Weekly review, `/review`, Weekly Review dialog |
| Schedule | Timetable, Day plan / Day Plan, Schedule, NOW block |
| Alerts | Alerts (Connect tab), Notifications (inbox, Settings group), alerts (handover), "Claude Code changes / Claude needs you" (notification kinds, not alerts) |
| Claude things | Claude chat, Claude Code, Claude's work list, Claude items (code), Sessions, Devices |
| Quick add | New task (sidebar), Add task (+ aria), Add a task... (bar), Quick add (docs) |
| Removing | Delete (task), Delete forever (trash), Drop (status), Archive, Revoke (key, device), Remove (passkey), Unlink (folder) |
| Notes | New note, Add a note, Open note |
| Modes | Mode (type of work) vs mode (schedule block mode) vs "Mode Definitions" |
| Settings vs Connect | Settings, "System status", "Claude, Discord & alerts setup", Connect |
| Handover vs app | Handover says More has "Trash" and Settings holds Status: both stale (Status moved to Connect; More shows "History & trash") |
- Suggests: one glossary: Tasks, Schedule, Review, Alerts, Claude, and verbs Delete/Archive/Remove.

### 5.9 Phone/desktop parity gaps
- Desktop-only: global shortcut N, full New-task form, board drag, hover comment edit, Today schedule column, bottom time-block bar.
- Phone-only: tab bar, More, long-press, row ⋯ sheet, Filters sheet, "Add & open", pull to refresh, sticky Mark done.
- Missing everywhere: bulk edit, global search, project delete, Claude item create, device rename, notification delete.
- Suggests: a keyboard palette on desktop (N plus search), and the phone quick-add chip row extended to mode.

### 5.10 Smaller observations
- 20 desktop sidebar links in 3 groups with no visual hierarchy beyond one "MODES" label; 3 badges only (Today, Untouched, Notifications).
- Weekly review dialog is not a sheet on phone while 12 other create/edit flows are.
- Modes page tabs (Active/All/Done) are state-only, so Back resets them.
- 5 native `confirm()` prompts break the app's own sheet pattern.
