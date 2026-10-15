# Work OS UX audit, stage 3: proposed structure

Status: proposal, awaiting Om's approval. Nothing is built.
Inputs: [analysis.md](analysis.md), [crawl-a.md](crawl-a.md), [crawl-b.md](crawl-b.md), [../ui-inventory.md](../ui-inventory.md) (with Om's notes), HANDOVER.md, launcher.md, WORK-STATE.md.
Numbers marked "est." are estimates from the crawl measurements; nothing here has been prototyped or run.
AGENTS.md applies to every slice: before writing code, read the relevant guide in `node_modules/next/dist/docs/`, because this Next.js has breaking changes.

## 0. The idea

Today the app is organised by build order: tasks first, then everything Claude-related buried inside each project, with 47 rows in More. The proposal reorganises it around what Om does all day:

- **Five places on phone:** Today, Projects, Claude, Tasks, plus `+`.
- **Claude becomes a layer across projects.** It gets its own place with all sessions, everything that needs Om, the queue, and keys and computers. "Start Claude" is also on `+`, so it's 2 taps from anywhere.
- **The project page becomes an overview** (Claude, Tasks, Notes, Repos), with "See all" for each.
- **Today leads with what needs attention.**
- **Everything rare moves behind one small Menu:** Review, Schedule, Modes, Settings. Connect is merged into Settings or the Claude area.
- **Phone and desktop have the same places.** Only the layout differs.

## 1. Principles

1. **Weight by frequency.**
   - A daily job takes at most 2 taps and no scrolling to start.
   - A weekly job takes at most 3 taps and no scrolling.
   - A rare job may be deeper but never needs a swipe.
   - Only the most frequent things get the bottom bar, the first screen and filled buttons.
2. **One home per thing.**
   - Each feature has one place where it is fully done.
   - Other places may show a slice, a count or a link, or offer an inline action on the same data, but never hold a copy of its state.
   - The project page's Claude card and the Claude area use the same component with a different filter.
3. **Claude is a cross-project layer.**
   - Sessions, items that need Om, the queue, Start, keys and computers are global.
   - Today shows Claude status.
   - A project shows its own slice and can start a session for itself.
4. **Overview first, detail one tap away.**
   - Every container (project, Claude, Today) opens on a summary of what needs attention.
   - Each part has "See all", which opens its full page.
   - Actions sit on rows (Answer, Next, Stop, Restore), not inside detail sheets.
5. **One grammar everywhere.**
   - **Back:** goes to where you came from, or to the parent if there is no previous in-app page.
   - **Names:** one word per thing (section 8).
   - **Confirms:** reversible actions act at once and show an Undo toast. Irreversible actions use a confirm sheet or dialog that names the thing, with a verb button. Never a native `confirm()`.
   - **Forms:** bottom sheet on phone and dialog on desktop, with the same fields, order and labels.
6. **Same structure on both surfaces.**
   - Same places, URLs and names.
   - The 768 px CSS switch changes layout only.
   - A control added to one surface is added to the other in the same slice.
   - State that must survive Back lives in the URL.

## 2. Information architecture

### 2.1 Top-level places

| Place | Route | What lives there |
|---|---|---|
| **Today** | `/today` | What needs Om now: Claude status and the question text of anything waiting, then overdue, due today, in progress and blocked tasks, then the current time block |
| **Projects** | `/projects`, `/projects/[id]` | Project list; Notes (a sibling view on the same hub); the project overview (Claude, Tasks, Notes, Repos) |
| **Claude** | `/claude` | All sessions, Needs you, the queue across projects, Start, and Setup (computers, keys) |
| **Tasks** | `/tasks` (`/board` redirects) | All tasks with search and filters (project, mode, due, stale); the 8 modes are a filter |
| **Inbox** | `/inbox` (`/notifications` redirects) | Notification list, reached from the bell on phone headers and the desktop sidebar |
| **Review** | `/review` (history, weekly review and untouched redirect here) | Done, Activity, Weekly, Stale, Archive, Trash |
| **Schedule** | `/schedule` (`/timetable` redirects) | Week template plus a Day/Week toggle; today's day plan is this page opened on today |
| **Settings** | `/settings/*` | This device, Alerts, Security, Connections, Help and recovery. Connect is merged in |

`+` is an action, not a place: Add task and Start Claude.

On phone, Notes is a segment of the Projects hub (`Projects | Notes`). On desktop it keeps its own sidebar row.

### 2.2 Mapping: old location to new location

**Tasks and Today**

| Old | New home |
|---|---|
| Today page (stats, NOW card, Overdue, Due today, In progress, Blocked, Up next, Also open, Routine) | Today. Stat tiles are removed; counts move into section headings. NOW shrinks to one expandable line. Up next, Also open and Routine are collapsed |
| Day plan (phone sheet and desktop dialog), Schedule column, Timetable page | Schedule (one page). Today has a "Schedule" button and, on desktop, a compact "Now and next 3 blocks" panel |
| Import, Work day buttons | Today header (unchanged) |
| Tasks list (phone) and board (desktop) | Tasks. Phone keeps its 4 segments; desktop keeps the board |
| 8 mode pages | Tasks `?mode=`; old `/modes/x` URLs redirect |
| Task page, quick add, full form, row actions, checklist, links, dependencies, comments, history | Unchanged; names fixed per section 8 |
| Untouched | Review › Stale |
| Weekly review | Review › Weekly |
| Trash (30-day restore) | Review › Trash |
| Archive, Unarchive | Review › Archive, with Restore on each row |
| History (Completed, Activity with actor filters) | Review › Done and Activity |

**Projects and notes**

| Old | New home |
|---|---|
| Projects list, New project | Projects (phone tab; desktop sidebar) |
| Project header and details form | Project › Info (Details). Name, client and status are also editable inline in the header |
| Project stat tiles | Counts in the Overview card headers |
| Open, Recently finished | Project › Tasks tab and the Tasks card |
| Claude items | Project › Claude tab and card (a slice of the Claude Queue) |
| Sessions (folders, Start/Stop/Resume/Remove/Link/Unlink) | Claude › Now (global). The project's Claude tab shows its slice |
| Code locations | Project › Info › Repos |
| Project Activity | Project › Info |
| Notes list, note page, New note | Notes (Projects hub segment on phone); a project's notes also show on its overview |
| Details-form notes box | Project › Info › Description |

**Claude and Connect**

| Old | New home |
|---|---|
| Connect › Claude Code (keys, create, revoke, command) | Claude › Setup |
| Connect › Devices | Claude › Setup › Computers |
| Folders reported by a computer | Claude › Setup › Computers (read-only, with link state). Linking happens in Start or in project Repos |
| Claude connector (30 tools), Reference | Settings › Connections › Claude chat, with the tool list in a collapsed Tools section |
| Connect › Claude chat | Settings › Connections |
| Discord tab, bot | Settings › Connections › Discord |
| Connect › Alerts (engine status, sent count) | Status line at the top of Settings › Alerts |
| Connect Overview, System status | The Settings landing status strip |
| 8 alert kinds, push per device, 12 switches | Settings › Alerts as one labelled table (kind × In-app/Push/Discord). Push for this device sits at the top of Settings › This device |
| Push test, "Notifications on this device" | Settings › This device |
| Password, passkeys, authenticator app, email reset, recovery codes | Settings › Security |
| Recovery page | Settings › Help and recovery (collapsed sections) |
| Theme, Sign out | Settings › This device; desktop sidebar footer icons mirror them; sign out has a confirm |
| Notifications page, bell | Inbox; the bell is on every top-level phone header, with a sidebar badge on desktop |
| More page (47 rows) | Removed; replaced by Menu (§3.3) |
| Current-block bar (desktop) | Unchanged; the sidebar leaves room for it |

Login, reset and the offline page are unchanged.

## 3. Phone navigation (below 768 px)

### 3.1 Bottom bar

```
 Today   Projects    (+)    Claude   Tasks
```

- 5 slots with targets of at least 44 px; `+` stays one tap.
- **Badges:** Claude shows a red count of items that need Om; Today shows the overdue count.
- **Lit tab = the place that owns the page:**
  - task page lights Tasks;
  - project and note pages light Projects;
  - Claude pages light Claude;
  - Inbox, Review, Schedule, Settings and Menu light nothing.
- Every top-level header has the title, then search, bell and menu icons (each 44 px).

### 3.2 What `+` offers

Quick add stays as it is (autofocused input, chips, typed syntax), with two changes:

- **Start Claude row** directly under the input: `Start Claude: (AKAR) (PMS) (Delpat) (Other…)`.
  - The chips are the 3 most recently used projects with linked folders; a project that needs a folder shows a warning dot.
  - Tapping a chip starts a session at once and shows the toast "Starting AKAR on Om-PC · Undo". Undo stops it.
  - "Other…" opens the full Start flow (§5.5).
  - The row hides as soon as Om types a task title.
- **The typed-syntax hint** (`@project !1 due:fri ~20m`) is shown on phone too, matching desktop.

### 3.3 Menu replaces More

`☰` in every top-level header opens `/menu`, about one screen:

```
Menu
 Review            Done · Activity · Weekly · Stale · Archive · Trash
 Schedule          Today's blocks and the week
 Modes             [8 mode chips → /tasks?mode=…]
 Settings     ●    system status dot
```

### 3.4 Back rules (phone)

- Header Back is an arrow with the name of where it goes (`‹ Today`).
- It goes to the page you came from. With no previous in-app page, it goes to the parent:
  - task → Tasks;
  - project → Projects;
  - note → its project;
  - a Settings section → Settings.
- Tab and segment changes inside a page use replace, so Back leaves the page.
- Overlay flows set a URL param (`?start=1`, `?item=C9`), so system Back closes them.
- Tapping the lit tab again scrolls to the top and resets to that tab's root.

## 4. Desktop navigation (800 px − 40 px time bar = 760 px)

### 4.1 Sidebar

```
 ┌ Work OS ───────────────┐
 │ [+ New task]       N   │
 │ [▶ Start Claude]   S   │
 │ 🔍 Search          /   │
 │ ─────────────────────  │
 │ Today              [3] │  overdue
 │ Tasks                  │
 │ Projects               │
 │ Notes                  │
 │ Claude             [2] │  needs you
 │ ─────────────────────  │
 │ Inbox              [8] │
 │ Review                 │
 │ Schedule               │
 │ Modes              ▸   │  collapsed; expands to 8
 │ ─────────────────────  │  pinned footer
 │ Settings           ●   │
 │ ☾  ⎋                   │  theme, sign out
 └────────────────────────┘
```

- About 500 px collapsed, so it fits in 760 px.
- With Modes expanded the nav region scrolls and the footer stays pinned. That also fixes the footer sitting under the time bar.
- The 8 mode links leave the main list.

### 4.2 Keyboard shortcuts

| Key | Action |
|---|---|
| `N` | Quick add (existing) |
| `Shift+Enter` in quick add | Full form (existing) |
| `Ctrl+Enter` in a comment | Add comment (existing) |
| `S` | Start Claude dialog |
| `/` or `Ctrl+K` | Search and jump (tasks, projects, notes, sessions, `#ref`) |
| `1`–`5` | Today, Tasks, Projects, Notes, Claude |
| `?` | Shortcut help |
| `Esc` or `[` | Back (closes a dialog first) |

Shortcuts are active only when focus isn't in a field and no dialog is open.

### 4.3 Back rules (desktop)

- Pages below the top level get a `‹ <destination>` link and a breadcrumb (Projects › AKAR › #9).
- Same came-from/parent rule as phone, and browser Back behaves the same.

## 5. Key screens

Phone is 390 × 844 with an 84 px bar; desktop is 1280 × 800.

### 5.1 Today

```
PHONE                                    
┌────────────────────────────────────┐
│ Thu 15 Oct          🔍  🔔(8)  ☰   │
│ NOW · Fiverr Ritual · Outreach  ▾  │
│ ┌ CLAUDE ──────────────────────┐   │
│ │ 1 needs you · 2 running [▶]  │   │
│ │ AKAR C9: "Which logo should  │   │
│ │ the header use?"             │   │
│ │ [ Reply…            ][Answered]  │
│ └──────────────────────────────┘   │
│ OVERDUE 5                          │
│ ○ P1 Send invoice          2d late │
│ ○ P1 Fix webhook           1d late │
│ ○ P2 Call Anaspure         1d late │
│   Show 2 more                      │
│ DUE TODAY 7                        │
│ ○ P1 Review PR             Today   │
├────────────────────────────────────┤
│ Today Projects (+) Claude Tasks    │
└────────────────────────────────────┘
```

- **Phone first screen:** Claude status with the question and an inline answer, Overdue, and the top of Due today.
- **Below the fold:** In progress and Blocked, then Up next, Also open and Routine collapsed.
- Tasks are no longer drawn twice, and the stat tiles are gone.
- With nothing waiting, the Claude card shrinks to `Nothing waiting · 2 running`.

```
DESKTOP
┌ Today · Thu 15 Oct        [Schedule] [Import] [Work day] ┐
│ [ + Add a task… (N) ]                                    │
│ ┌ left (60%) ───────────────┬ right (40%) ──────────────┐│
│ │ OVERDUE 5                 │ CLAUDE         [▶ Start S]││
│ │  ○ P1 Send invoice  2d    │ NEEDS YOU 1               ││
│ │  ○ P1 Fix webhook   1d    │  AKAR C9 "Which logo…"    ││
│ │ DUE TODAY 7               │  [Reply…       ][Answered]││
│ │ IN PROGRESS 3             │ RUNNING 2                 ││
│ │ BLOCKED 1                 │  ● AKAR · Om-PC   [Stop]  ││
│ │                           │ NOW & NEXT                ││
│ │                           │  Fiverr Ritual (now)      ││
│ │                           │  Deep work 14:00  Full ›  ││
│ └───────────────────────────┴───────────────────────────┘│
```

On desktop, a compact "Now and next 3 blocks" panel replaces the 21-block schedule column.

### 5.2 Project page as an overview

```
PHONE
┌────────────────────────────────────┐
│ ‹ Projects                    ⋯    │
│ AKAR            Acme · Active      │
│ [▶ Start Claude]      [+ Task]     │
│ Overview Tasks Claude Notes Info   │
│ ┌ CLAUDE ─────────────── Open › ┐  │
│ │ 1 needs you · 1 running · 4 queued │
│ │ Next: C12 Reorder invoice export   │
│ │ ● open on Om-PC 12m       [Stop]   │
│ └────────────────────────────────┘ │
│ ┌ TASKS 25 open · 4 late  All › ┐  │
│ │ ○ P1 Fix webhook        Today │  │
│ │ ○ P1 Update schema      Fri   │  │
│ │ ○ P2 …       +22 more         │  │
│ └────────────────────────────────┘ │
│ NOTES 3  All ›  Brief · Scope · Call│
├────────────────────────────────────┤
│ Today Projects (+) Claude Tasks    │
└────────────────────────────────────┘
```

- **Below the first screen:** Repos (`2 repos · 1 folder linked ›`) and the last 3 activity entries.
- **Details form:** moves to Info; name, client and status are editable from the header.
- **Desktop:** Claude and Tasks sit in the main column, with Notes, Repos and Activity on the right. The same tabs exist as `?tab=`.

### 5.3 Claude area

```
PHONE (Now tab)
┌────────────────────────────────────┐
│ Claude                 🔍 🔔 ☰     │
│ [▶ Start Claude]                   │
│ ( Now )  Queue  Setup              │
│ NEEDS YOU 2                        │
│ ┌ AKAR · C9 ──────────────────┐    │
│ │ Which logo should the header│    │
│ │ [ Reply…          ][Answered]    │
│ └─────────────────────────────┘    │
│ RUNNING 2                          │
│  ● AKAR   Om-PC  12m       [Stop]  │
│  ● Delpat Site  starting…  [Stop]  │
│ RECENT 4  ▾  Resume · Remove       │
├────────────────────────────────────┤
│ Today Projects (+) Claude Tasks    │
└────────────────────────────────────┘
```

- **Now:**
  - Needs you, with Reply and Answered on the same row.
  - Running, with honest states.
  - Recent, with Resume and Remove.
- **Queue:** all items across projects, grouped by project, with Next and Top buttons and a reorder handle on each row.
- **Setup:** Computers (online, last seen, folders and their link state) and Keys (create, revoke), both revoked through confirm sheets.
- **Confirms:** Stop asks first; Remove shows an Undo toast.
- **Freshness:** the page refreshes on focus and every few seconds while visible.
- **Desktop:** Needs you on the left; Running, Recent and Computers on the right.

### 5.4 Settings with Connect merged in

```
PHONE
┌────────────────────────────────────┐
│ ‹ Menu   Settings                  │
│ ✓ All systems OK                   │
│   Push on · Alerts running · Email on│
│ THIS DEVICE                        │
│  Push on this device     [on ]     │
│  Theme            Light Dark Auto  │
│  Send test · Sign out              │
│ Alerts           6 of 8 on     ›   │
│ Security         Passkey 1     ›   │
│ Connections      Chat ✓ Discord ✗ ›│
│ Help and recovery              ›   │
└────────────────────────────────────┘
```

- **Alerts:** one labelled table, kind × In-app/Push/Discord. Channels that are always on or not set up say why.
- **Connections:** one card per integration with its status and setup.
- **Desktop:** a left sub-nav with all 5 sections.

### 5.5 Start Claude flow

**Entry points**, all the same flow:
- the `+` chips;
- Start on the Claude area and on a project;
- the desktop sidebar button and the `S` key;
- Today's Claude card.

1. **Pick a project.** Search, then Recent (projects with a linked folder), then All. Projects that need a folder are marked.
2. **Confirm.** Computer (only when there's more than one), Folder (radio buttons), an optional first message, then Start. The folder step adapts:
   - **Linked:** pick from the list. With one folder and one computer, only the message and Start show.
   - **Same repo, not linked:** **Link and start**.
   - **Nothing linked:** search the computer's folders; picking one links it and starts.
3. **Result:** a toast, and a Running row appears on Claude.

Start still only creates a job, the worker launches, and paths never leave the PC. On desktop it's a dialog: `S`, type, `Enter`, `Enter`.

## 6. Before and after, top jobs

Taps (T) and swipes (S). "Now" comes from the crawls (emulated 390 px and 1280 px, throwaway DB). "Proposed" is estimated, not built.

| # | Job | Phone now | Phone proposed (est.) | Desktop now | Desktop proposed (est.) |
|---|---|---|---|---|---|
| 1 | Add a task | 2T + input | same | N + Enter | same |
| 2 | Mark done | 1T | 1T | 1 | 1 |
| 3 | Read Today (overdue and due) | 3S; Overdue at 13% of the first screen | 0S, on the first screen | 2S | 0S |
| 4 | Start a session, folder linked | 4T/4S = 8 | 2T/0S | 7 | ~3 keys + input |
| 5 | Start with a message | 10 | 4T + input | 9 | 4 keys + input |
| 6 | Start with a same-repo suggestion | 8 | 4T | 7 | 3 keys |
| 7 | Start with nothing linked | 10 | 5T + input | 8 | 4 keys + input |
| 8 | See waiting items with their text | counts only; 3T via the bell | 0T on Today; 1T full list | counts only | 0 / 1 |
| 9 | Answer a waiting item | 3T | 1T | 3 | 1 |
| 10 | Answer with a note | 4T + input, then the sheet freezes | 2T + input | same | same |
| 11 | See all sessions | 12T/17S = 29 | 1T | 23 | 1 (key `5`) |
| 12 | Stop a session | 3T/5S = 8, no confirm | 3T with a confirm | 6 | 3 |
| 13 | Resume or remove a session | 7–8 | 2–3T | 6 | 2 |
| 14 | Open a project | 2T | 2T, landing on the overview | 2 | 2 |
| 15 | Mark a queued item Next or reorder | 8 | 3T | 7 | 3 |
| 16 | Find a task | 3T + input | 2T + input | 3 + Enter | 2 keys, live |
| 17 | Change status, priority and due on one task | 5T | 5T | 5 + input | 4 (inline due) |
| 18 | Find a project's notes | 3T/3–4S | 3T/0S | 3 | 3 |
| 19 | Block with a reason | 3T + input; desktop never asks | 3T + input everywhere | 2, no reason | 3 + input |
| 20 | Check or tune alerts | 5–6 | 2T status / 4T toggle | 2 | 2 |
| 21 | Add a computer or key | 8 | 3T + input | 3 + input | 3 + input |
| 22 | Link a repo | 9 | 4T (or done inside Start) | 3 | 4 |
| 23 | Un-archive | 6T, 5 screens | 4T | 4 | 3 |
| 24 | Change the password | 11 | 5T + 3 inputs | 5 | 4 |
| 25 | Theme, sign out | 7 | 3–4T | blocked by the footer bug | 1 |

- **Big wins:** the Claude jobs (4–13, 15) go from 7–29 actions to 1–4, and Today shows what needs attention without scrolling.
- **Unchanged:** add, done, open a project, task edits.
- **A step worse:**
  - desktop block now requires a reason;
  - password and Review cost one more Menu tap, but no swipes.

## 7. Room for the future

Rule: a new feature fits as a tab, a card, a row action or a setting inside an existing place. A new top-level place needs Om's yes.

| Coming or likely | Where it goes |
|---|---|
| Session logs and transcripts | Session row → `/claude/sessions/[id]` (Overview, Log). The worker needs a log file first |
| Multiple computers | A Computer select in Start; listed under Setup; Running rows already name the computer |
| Scheduled sessions | A "Now / Later" toggle in Start; a "Scheduled" group in Claude › Now (needs data and worker changes) |
| More Claude features | A card in Claude › Now, or a new Claude tab only when it is a whole list |
| Global search | Header icon on phone, `/` or `Ctrl+K` on desktop, with scope chips |
| Bulk edit | A Select mode on Tasks with a sticky action bar; the same pattern later for Queue and Trash |
| Project delete | Project › Info, with a confirm; the project goes to Review › Trash for 30 days |
| More integrations | One card each in Settings › Connections, plus their alert kinds as rows in Alerts |
| Team members | Settings › Team, an assignee field and filter, project Members, "Mine / Everyone" filters (needs data changes and a permissions review) |

## 8. Naming glossary

| Concept | Name | Replaces |
|---|---|---|
| Place for all tasks | **Tasks** | Tasks, Board, Open (as a place) |
| Task states | **To do, In progress, Blocked, Done, Dropped** | Not Started, To do |
| Unfinished filter | **Open** | Open, Waiting |
| Finish a task | **Done** (button "Mark done") | Mark done, Complete |
| Put a task away | **Archive**, **Drop** (a status), **Delete** (to Trash), **Delete forever** (Trash only) | mixed Delete/Remove/Archive |
| Bring something back | **Restore** | Unarchive, Restore |
| Day and week plan | **Schedule** | Day plan, Day Plan, Schedule, Timetable |
| In-app list | **Inbox** | Notifications |
| Delivery settings | **Alerts** | Alerts, Notifications |
| Claude asks Om | **Needs you** | Waiting on you, for you, needs you |
| Respond | **Reply** (note), **Answered** (clears the flag) | Add a note, Log |
| Claude's work list | **Queue** / **Queue item** | Claude items, work list |
| One run on a folder | **Session** | session, job |
| Start one | **Start Claude** | Start (two buttons), Add |
| A PC that runs sessions | **Computer** | Device, Computer |
| Claude Code access | **Key** | Claude Code key, MCP key |
| A project's git remote | **Repo** | Code locations |
| A path on a computer | **Folder** (Link folder, Unlink) | Add a folder, Link |
| Claude on claude.ai | **Claude chat** | Claude, Claude chat connector |
| Comment on a task | **Comment** | Add a note, COMMENT |
| A document | **Note** | Note, page note |
| Project description box | **Description** | notes textarea |
| History hub | **Review** | History and trash, Weekly review, Untouched, Recovery |
| Not touched for a while | **Stale** | Untouched, hidden |
| Making something | **Add** (task, comment, key, folder, computer); **New** (note, project, review) | Create, Add & open |
| Help page | **Help and recovery** | Recovery |

## 9. Build plan

Ordered by pain. "Server" = a new or changed route or query; "Data" = a schema change.

| # | Slice | Type | Why this order |
|---|---|---|---|
| 0 | Defects in progress: item sheet freeze, sidebar footer, clipped Day plan, unlabeled switches | UI | Don't carry them into the new structure |
| 1 | **Claude area, Now tab:** Needs you (inline Reply + Answered), Running and Recent with a Stop confirm, Resume, Remove with Undo; Claude badge; Claude tab on the phone bar for now; sidebar link | Server read + UI | Jobs 8 and 11 (up to 29 actions) |
| 2 | **Start Claude flow:** shared two-step component, `+` chips with Undo, link-and-start, desktop `S` | Small server read + UI | Most frequent Claude action: 8 → 2 |
| 3 | **Project overview:** tabs, Start and + Task on the first screen, details moved to Info | UI | The root cause Om described |
| 4 | **Today rebuilt:** attention first, a Claude card, NOW as one line, no duplicates, no tiles, desktop right column | UI | Most frequent read |
| 5 | **Phone shell:** new bar, Menu, Projects | Notes hub, modes as a filter, lit-tab rules, header bell and menu, redirects | UI | More disappears once everything has a home |
| 6 | **Claude Queue and Setup:** row controls; keys and computers moved from Connect; confirm sheets replace `confirm()` | UI | Completes the Claude area |
| 7 | **Settings merge:** status strip, sections, Alerts table, Connections cards, Help; `/connect` redirects | UI | Removes the second Settings |
| 8 | **Desktop sidebar:** new order, collapsed Modes, pinned footer, shortcuts, Back control | UI | Fits 800 px |
| 9 | **Review hub:** merged History, Weekly, Stale, Archive and Trash; Restore on rows | UI + small read | Rare jobs in one place |
| 10 | **Grammar pass:** Back rule, renames, one Block flow, inline due on desktop, Undo and confirm rules | UI | Mechanical once the places exist |
| 11 | **Global search** | Server + UI | New capability after the structure is stable |
| 12 | **Later, each on Om's request:** bulk edit, session logs, scheduled sessions, project delete, team | Data / server | See §7 |

- Slices 1–5 carry most of the value. After slice 3, "find the project, scroll, click add" is gone.
- No data migration is needed in slices 0–10.
- A review subagent runs before merging any slice that touches auth or permissions.
- Every slice keeps 44 px targets, 16 px text, the 768 px switch, `data-sheet`, URL state and PWA behaviour, and reads the Next.js guide first.

## 10. Open questions for Om

1. **Notes become a segment next to Projects on phone** (it stays a sidebar row on desktop), so the 5th slot can go to Claude. Notes then cost 1 more tap. *Recommend yes:* notes are a weekly job and belong to projects.
2. **A recent-project chip on `+` starts a session at once** with an Undo toast: 2 taps. With no, it's 3 taps plus a confirm step. *Recommend yes:* a start only creates a job, and Undo is one tap.
3. **The 8 mode pages become a filter on Tasks**, with one collapsed Modes row and redirects. That frees 7 sidebar rows and 8 phone rows. *Recommend yes.*
4. **Keys and computers move into Claude › Setup, not Settings.** *Recommend yes*, as you suggested: everything for Claude Code in one place.
5. **Today drops the stat tiles and the 21-block schedule column** for a Claude card and "Now and next 3 blocks"; the full schedule stays one tap away. *Recommend yes:* attention items lead.
