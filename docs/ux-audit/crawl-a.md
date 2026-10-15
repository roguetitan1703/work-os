# Work OS UX audit, crawler A: daily work

Measured on the running app, 2026-10-15, against a throwaway database. Input for a later analysis; no redesign is proposed here.

## 0. How this was measured

- **App:** production build of master (`next build` + `next start`, port 3431) on a throwaway single-node replica-set mongod (port 27131, DB `workos_uxa`). Discord, push, email and cron env were not set, so nothing real was sent. A copy of the repo was built so the real working tree and `.next` were not touched.
- **Data:** 6 projects (Grant Leads is the big one: 25 tasks), 50 seeded tasks across P1-P4, overdue / today / future / no due date, 3 blocked, a 3-task dependency chain, done / dropped / archived / trashed items, comments, progress, 8 notes (project notes and one task note), 8 inbox notifications. Tasks created during the run (about 12) are mixed into the lists.
- **Devices:** Playwright Chromium, desktop 1280x800, phone 390x844 at 2x with touch (taps).
- **Counting rules**
  - Start = the job starts from `/today` (the landing page) unless a row says otherwise.
  - **Tap / click** = one pointer action or one key (N, Shift+Enter). Typing is counted separately as an **input** (one text field filled). Native `<select>` pickers (project, mode, status and priority on desktop rows) are counted as 2 (open + choose); Playwright cannot show the OS picker, so this is the minimum.
  - **Scroll** = one step of 70% of the viewport (591 px phone, 560 px desktop) until the target's top is in view. Scrolls are counted from the top of the page.
  - **Screens** = new pages, sheets or dialogs entered after the start.
  - "Works / awkward / doesn't work" is a rating of what was run, not an opinion on the design: works = did the job as expected; awkward = did it, but with extra steps, a surprise or a mismatch; doesn't work = the job could not be done that way.
- **Screenshots:** `.scratch-mongo/ux-shots/a/` (327 files, outside git, local only). Names are `<job>-<p|d>-<NN>-<step>.png`; p = phone, d = desktop. Earlier runs of the same step share a name and were overwritten by the last run. Probe shots start with `probe-`, `x-` or `DBG-`.
- **Not covered:** real OS pickers, long-press (450 ms) on rows, drag on the board, pull to refresh, the Claude/Discord/connect areas (crawler B), and the real clock: the NOW block follows the time of day (the run covered Morning Anchor, Fiverr Ritual and later blocks), so the first screen of Today changes through the day.

---

## 1. Jobs table

Taps/clicks and scrolls are from `/today`. "In" = text inputs. Rating is for the best path found.

| # | Job | Phone: taps / scrolls / in / screens | Desktop: clicks / scrolls / in / screens | Rating |
|---|---|---|---|---|
| J1 | See what's on today | 0 / 3 to read Overdue, Due today, In progress, Blocked (page = 6.0 screens) | 0 / 2 (page = 3.1 screens) | works, but the order differs by device |
| J2 | Add a task fast | 2 (+, Add task) / 0 / 1 / 1 sheet | 1 key N + Enter / 0 / 1 / 1 dialog; or 1 click on the inline bar + Enter, 0 new screens | works |
| J3a | Add with project, due, priority (chips) | 5 (+, due chip, priority chip, project chip, Add task) / 0 / 1 / 1 | not available (desktop has no chips) | works |
| J3b | Same, by typed syntax `@"Project" !1 due:fri` | 2 / 0 / 1 / 1 (syntax is not hinted on phone) | 1 key + Enter / 0 / 1 / 1 (hint line under the box) | works, hidden on phone |
| J3c | Same, by full form | none on phone | 7 (N, Shift+Enter, project field, priority open+pick, due field, Create) / 0 / 3 / 2 | works |
| J4a | Change status on a task | row ... then status: 2 per field (sheet closes after each pick) | row status select: 2 | works |
| J4b | Change due date | row ... then Tomorrow/Today chip: 2; or task page 2 | no inline edit: open the task (1) + type in the date field (1 input); with the calendar widget 3+ | awkward on desktop |
| J4c | Change priority | row ... then P1-P4: 2 | row priority select: 2 | works |
| J4d | Change status + priority + due on one task | 1 open + 3 chips + 1 Back = 5 / 0 / 0 / 2 | status 2 + priority 2 + task page for due 1 + 1 input = 5 + 1 input | works |
| J5 | Mark done | 1 (circle), Undo toast | 1 (circle), Undo toast | works |
| J6a | Block with reason (phone sheet) | row ..., Blocked, type, Mark blocked = 3 / 0 / 1 / 2 | n/a | works |
| J6b | Block with reason (task page / desktop) | page: row, Blocked, red prompt, type, Save = 4 / 0 / 1 / 2. Blocked is already saved before the reason | row select Blocked = 2 (no reason asked); reason = open task + click field + type = 2 more + 1 input | awkward: 3 flows, 3 behaviours |
| J7 | Comment on a task | row, field, send = 3 / 2 / 1 / 1 | title, then Ctrl+Enter (or Add note) = 1-2 / 1 / 1 / 1 | works |
| J8 | Move to another project | row, Project row, pick = 3 / 0 / 0 / 1 | title, click field, type name, click away = 3 / 0 / 1 / 1 | works, different widgets |
| J9a | Find a task by search | Tasks tab, search field, result = 3 / 0 / 1 / 2 | Tasks, search, Enter, card = 3 / 0 / 1 / 2 (Enter needed) | works |
| J9b | Find a task by browsing (no search) | Tasks tab = 1 / 6 for a P4 task in a 51-task list | 1 / 5 | awkward |
| J9c | Find a task through its project | More, project = 2 / 3 | Projects, project = 2 / 1 | works |
| J10 | Open a project and see its state | More, project = 2 / 0 / 0 / 2 | Projects, project = 2 / 0 / 0 / 2 | works |
| J10b | Reach the Projects list | More, All projects = 2 (no row for it on phone) | 1 | awkward on phone |
| J11a | Find a project's notes (via the project) | More, project, [scroll to Notes], note = 3 / 3-4 (Notes begins at 2,372 px of a 5,079 px page) | Projects, project, note = 3 / 0 (right column on first screen) | awkward on phone |
| J11b | Find a project's notes (Notes tab filter) | Notes, project chip, note = 3 / 0 | Notes, select open, pick, Filter button, note = 5 / 0 | works / awkward on desktop |
| J12 | Write a note | Notes, New, title, [project chip], Create, body field = 5 / 0 / 2 / 3 | Notes, New note, title, [select open+pick], Create, body field = 6 / 0 / 2 / 3 | works; no standalone notes |
| J13 | Check notifications and act on one | bell, row = 2, + Back = 3 / 0 / 0 / 3 | Notifications link, row = 2 / 0 / 0 / 2, no Back (1 more click to return) | works |
| J14 | See what changed (History > Activity) | More, History, Activity = 3 / 0 / 0 / 3 | History, Activity = 2 | works |
| J15a | Restore from Trash | More, History, Trash, Restore = 4 / 0 / 0 / 3 | History, Trash, Restore = 3 | works |
| J15b | Un-archive | More, History, Archived, task, ..., Unarchive = 6 / 0 / 0 / 5 | History, Archived, task, Restore = 4 / 0 / 0 / 3 | awkward (worst by taps) |
| J16a | Plan the day: Day plan | Day plan button = 1 / 0 / 0 / 1 sheet (lists all 49 open tasks, not only today's) | 1 / 0 / 0 / 1 dialog (clipped, see 4.9) | awkward on desktop |
| J16b | Timetable page | More, Timetable = 2, + 1 per other weekday / 0 / page = 3.1 screens | 1 / page = 2.7 screens | works (read-only) |
| J17 | Weekly review | More, Weekly review, + = 3, then 7 fields + Save (1) | 2, then same form + Save | works |
| J18 | Today > task > project > back | task, project = 2; UI Back from project = 3rd tap, lands on Projects list; system back lands on the task | task, project = 2; no Back control; sidebar Today = 3rd click | awkward |
| J19 | Open a mode page | More, mode = 2 | sidebar = 1 | works |
| J21 | Add a task inside a project | More, project, +, title, Add task = 4 taps + 1 input; project preselected | Projects, project, bar, type, Enter = 3 clicks + 1 input; project preselected | works |
| J22 | See what's due soon | Tasks, Due soon segment = 2 | Tasks, due select open, pick = 3 | works |
| J23 | Untouched | More, Untouched = 2 | 1 | works (empty in this data) |

**Worst by effort (phone):** un-archive (6 taps, 5 screens), find a task by browsing (6 scrolls), a project's notes via the project (3 taps + 3-4 scrolls, about 2,400 px down), Today's four attention lists (3 scrolls), block with reason on the task page (4 taps), write a note (5 taps).
**Worst by effort (desktop):** notes of a project via Notes (5 clicks), find a task by browsing the board (5 scrolls), un-archive (4), due-date change (no inline edit), write a note (6 clicks with a project change).

---

## 2. Per-job step paths

Abbreviations: **T** tap/click, **S** scroll, **I** text input. Shots are in the shots folder.

### J1 See what's on today
- Phone: open `/today` (0 T). First screen (844 px, usable 760 above the tab bar): title row, 3 buttons (Day plan, Import, Work day), 3 stat tiles (Overdue 5, Due today 7, In progress 3), then the NOW card (collapsible) with the current time block's tasks. Overdue starts at y=658 (13% visible: heading and the top of one row). S1 shows Overdue rows, S2 Due today, S3 In progress and Blocked. Up next, Also open and Routine follow (page 5,061 px = 6 screens). Shots: `J1-today-p-01-start.png`, `probe-p-today.png`.
- Desktop: 0 T. First screen: 6 stat tiles, add bar, a Schedule column (all 21 time blocks, always) and the NOW card (61% of the height). Overdue's heading peeks at y=720; S1 shows Overdue and Due today, S2 In progress and Blocked. Page 2,463 px = 3.1 screens. Shots: `J1-today-d-01-start.png`.

### J2 Add a task fast
- Phone: T `+` (tab bar, sheet opens with the keyboard on a textarea "What needs doing?") > I title > T Add task. 2 T + 1 I. Shots `J2-add-fast-p-02..04`. Result: task with no mode, P2, no project.
- Desktop: key N (dialog "Quick add") > I title + Enter. 1 key + 1 I. Or click the inline bar on Today (no dialog) + I + Enter. Shots `J2-add-fast-d-02-key.png`, `J2-add-fast-inline-d-02-click_Add_a_task_bar.png`. Result: mode = the current time block's mode (Code & Dev when run in the morning).

### J3 Add with project, due and priority
- Phone chips: T + > I title > T "Tomorrow" > T "P1" > T project chip > T Add task (5 T + 1 I). The sheet has Due (Today, Tomorrow, Friday, Next week), Priority (P1-P4), Project (6 chips, scrolls sideways), Add & open, Add task. No mode, tags, estimate or date picker. Shots `J3-add-full-chips-p-02..07`.
- Phone syntax: T + > I `Send invoice @"Fiverr Gigs" !2 due:fri ~20m` > T Add task. It parsed to project Fiverr Gigs, P2, due 2026-10-16 (a Friday), but nothing on screen says so. Shot `J3-add-full-syntax-p-04-syntax-preview.png` (no preview or hint).
- Desktop syntax: N > I `... @"Acme Client Portal" !1 due:tomorrow` + Enter. The dialog shows a hint: `@project !1-!4 #tag due:fri start:mon ~45m mode:code`. Shot `J3-add-full-syntax-d-03-typed.png`.
- Desktop form: N > I title > Shift+Enter (form: description, project, mode, priority, status, start, due, estimate, tags, checklist, links) > click project, type > open priority, pick P1 > click due, type the date > Create. 7 T + 3 I. Shots `J3-add-full-form-d-05-form-open.png`, `J3-add-full-form-d-10-Create.png`.

### J4 Change status, due date, priority
- Phone, row sheet: T row `...` (sheet: status as 5 buttons, priority 4, due chips incl. "Pick", mode chips, Open task) > T the value. The sheet closes after one change, so each field costs 2 T. Shots `J4-status-via-sheet-p-02..03`, `J4-due-via-sheet-p-03`, `J4-priority-via-sheet-p-03`.
- Phone, task page: T the row title (page: Status 3 buttons, Priority, Due chips, Progress) > T status > T priority > T due > T Back. 5 T, 2 screens. Each tap saves at once. Shots `J4-status-due-prio-via-page-p-02..06`. The page's Status shows 3 states (Done is the green "Mark done" bar, Dropped is under the top-right ...).
- Desktop: row status select (T open + T option = 2), row priority select (2). Due date is plain text on every row (Today, Board, Project): open the task (T title) then fill the Due date field (I) and tab out. Shots `J4-status-via-row-select-d-03-picked.png`, `J4-due-via-task-page-d-03-typed-date.png`.

### J5 Mark done
- Both: T the circle on the row. Toast "Done: <title>" with Undo (phone, over the header). 1 T. Shots `J5-mark-done-p-02-...`, `J5-mark-done-d-02-...`. Desktop also has Complete on the task page; phone has the sticky green "Mark done" bar.

### J6 Block with a reason
- Phone, sheet: T row `...` > T Blocked > a red box "What is it blocked on?" opens inside the sheet and Mark blocked stays disabled until text is typed > I reason > T Mark blocked. 3 T + 1 I. Nothing is saved before the reason. Shots `J6-block-via-sheet-p-03..04`.
- Phone, task page: T row title > T Blocked (saves at once, toast "-> Blocked") > T the red line "Add the reason it is blocked" (second sheet) > I reason > T Save. 4 T + 1 I, 2 screens. The task is already Blocked if you stop after tap 2. Shots `J6-block-with-reason-p-04-after-blocked-tap.png`, `J6-block-with-reason-page-p-*`.
- Desktop: row status select > Blocked (2 T): saved at once, toast "#25 -> Blocked", no reason asked (`J6-block-with-reason-d-03-after-blocked.png`). The reason is an inline field on the task page ("Waiting on client feedback, missing access..."): T title, T field, I. Shots `J6-block-reason-on-task-page-d-03-task-s0.png`.

### J7 Comment on a task
- Phone: T row title > S2 to reach COMMENT (page 1,696 px = 2.0 screens; the box sits at 1,324 px; the sticky "Mark done" bar covers the bottom edge) > T field + I > T send arrow (grey until text). Comment appears at the top of HISTORY, which is directly below. Shots `J7-comment-p-02..05`.
- Desktop: T title > S1 > I in "Decision, call notes, what happened... (Ctrl+Enter)" > Ctrl+Enter or the Add note button. Shots `J7-comment-d-*`.

### J8 Move to another project
- Phone: T row title > T the Project row (native select, over the task page's "Project / Mode / Start / Estimate / Repeats / Tags" list) > T option. Worked: the task moved. Shots `J8-move-project-p-02..`.
- Desktop: T title > T the Project field (text with a datalist, "New or existing") > I project name > click away to save. The field accepts any text; a new name would presumably create a project (not tested). Shot `J8-move-project-d-*`.

### J9 Find a specific task (no global search exists)
- Search (phone): T Tasks tab > T search field > I "Rate-limit" (live filter) > T result. Search covers tasks only, and `#ref` works ("Search tasks or #ref"). Shots `J9-find-task-search-p-*`.
- Search (desktop): T Tasks > T search box > I + Enter (not live; URL becomes `/board?q=...`) > T card. Shots `J9-find-task-search-d-04-typed.png`.
- Browse (phone): T Tasks > 6 scrolls to a P4 task (page 4,382 px = 5.2 screens; sections P1 11 rows, P2 19, P3 15, P4 6). Browse (desktop): 5 scrolls through the To do column.
- Through a project (phone): More > Grant Leads > 3 scrolls (25 tasks, 1,480 px list). Desktop: Projects > Grant Leads > 1 scroll.
- What Om does instead, in practice: the Tasks search box, or the project page. There is no search from Today, Notes or a project page, and Notes search covers notes only.

### J10 Open a project and see its state
- Phone: T More > T "Grant Leads" (row shows "23 - 4 late") > project page. 2 T. First screen is the details form (see 3.5), the stats come second, the tasks third. Shot `J10-open-project-p-03-Grant_Leads_row.png`.
- Desktop: T Projects > T the project card (the card shows done/open, overdue / in progress / blocked / done this week, last activity). Project page first screen: title, status select, notes box, 4 stat tiles, add bar, the Open list; right column: Notes, Code locations, Activity. Shots `J10-open-project-d-03-Grant_Leads.png`, `x-d-project.png`.
- Projects list: phone has no row for it in More (only "All projects", which opens it in the "All" filter) and the project page's back link goes to it (`J10b-projects-list-p-03-projects-page.png`). Desktop: sidebar, 1 T.

### J11 Find a project's notes
- Via the project (phone): More > project > scroll 3-4 (Open 581-2,081, Recently finished 2,081, Sessions 2,268, Notes 2,372) > T note. 3 T + 3-4 S. Desktop: Projects > project > Notes list in the right column on the first screen > T note. 3 T, 0 S. Shots `J11-project-notes-via-project-p-04-...`, `J11-project-notes-via-project-d-04-...`.
- Via Notes (phone): T Notes > T project chip > T note. Desktop: T Notes > T project select > T option > T Filter button > T note (5). Shots `J11-project-notes-via-notes-tab-*`.

### J12 Write a note
- Phone: T Notes tab > T New (sheet "New note": Title + 6 project chips, first chip preselected, note "Notes are filed under a project. For a task's note, open the task.") > I title > T project chip if not the preselected one > T Create note (opens the note page) > T body > I text. Shots `J12-write-note-p-02..08`.
- Desktop: T Notes > T New note (inline in the page header: Title, project select, Create, Cancel) > I title > T select + T option > T Create > T body > I. Shots `J12-write-note-d-04-after.png` (the form), `J12-write-note-d-08-body-typed.png`.
- No note can be created without a project or task. Desktop caution: the sidebar's "New task" button sits above the page's "New note" button.

### J13 Check notifications and act on one
- Phone: T bell (header, badge "8") > list of 8 rows (dot colour = kind, title, detail, age; row = 85-106 px, 11-14% of the screen each, 7 visible) > T a row > the task page > T Back (returns to the list). No dismiss, snooze or mark-as-read control. Shots `J13-notifications-act-p-02-bell__header_.png`, `-p-04-Back.png`.
- Desktop: T Notifications (sidebar, badge "8") > T a row > task page; no Back, the sidebar link is the way back (+1 T). Shots `J13-notifications-act-d-02-...`.
- Read state: a first open shows "8 new"; opening it again after a few seconds showed "All caught up" with the rows still listed; leaving within about a second left them unread.

### J14 See what changed today (History)
- Phone: T More > T History & trash > T Activity (tabs: completed, activity, archived, trash). The default tab Completed opens on a "Completed per week" chart (about 160 px, 21% of the screen) and then week groups. Page 1,220 px. Desktop: T History & trash > T Activity. Shots `J14-history-what-changed-p-04-Activity_tab.png`.
- "What changed today" is a filter inside Activity (all actors), not a "today" view.

### J15 Restore from Trash; un-archive
- Restore (phone): More > History & trash > Trash > Restore (row has Restore and Delete forever side by side). 4 T. Desktop: 3 T.
- Un-archive (phone): More > History & trash > Archived > T the task (task page) > T "..." (More actions) > T Unarchive. 6 T, 5 screens. Archived rows have no action of their own. Desktop: History & trash > Archived > the task > Restore button. 4 T. Shots `J15-unarchive-p-07-Unarchive.png`, `J15-unarchive-d-05-Restore__task_page_.png`.

### J16 Plan the day
- Day plan (phone): T Day plan (Today header) > sheet "Day plan", "49 tasks, 20m estimated, 13h 55m in schedule", then all time blocks with the tasks assigned to them (priority, estimate, "blocked" or "in progress"). Shots `J16-plan-day-dayplan-p-02-Day_plan_button.png`.
- Day plan (desktop): same content in a dialog that is 384 px wide with 561 px of content: the left part is clipped (see 4.9). Shot `DBG-d-02-dayplan-settled.png`, `J16-plan-day-dayplan-d-02-Day_plan_button.png`.
- Timetable page: phone T More > T Timetable, one day at a time (Mon-Fri tabs, today marked); page 2,634 px (3.1 screens): time, block name, mode chip, a sentence. It lists blocks, not tasks. Desktop: one table, Mon-Fri columns, 2,193 px. Shots `x-p-timetable.png`, `J16-timetable-page-d-02-...`.

### J17 Weekly review
- Phone: T More > T Weekly review > T "+" > full-screen form: Week of (date), Shipped, Slipped, To Drop, Broken Days, Extension Tokens Used, Adjustments > T Save review. 3 T to open + 7 fields + 1 T. Empty state is "No reviews yet. Tap + to log your first weekly review." Shot `J17-weekly-review-p-04-____New_review.png`. Desktop: T Weekly review > T New review (dialog).
- The form does not show the week's done, slipped or dropped tasks; everything is typed.

### J18 Switch Today > project > task and back
- Phone: Today > T task title (`/tasks/9`) > T project link under the title (`/projects/grant-leads`) > UI Back link ("Projects") goes to `/projects`, not to the task; system Back goes to the task, a second system Back to Today. From a task opened on Today, the UI Back returns to Today. From a note opened on a project page, UI Back goes to Notes (the list), not the project. From a notification, UI Back returns to Notifications. Shots `J18-today-project-task-back-p-04-Back__UI__from_project.png`.
- Desktop: no Back control on task or project pages; the sidebar (Today) is the way back (1 T); browser Back behaves as expected (task > project > back > task > back > Today). Note page has a "Notes" breadcrumb that returns to the list.

### J19, J21, J22, J23 (other jobs found)
- Mode page: phone More > Code & Dev (2 T); desktop sidebar (1). The page is a coloured description card, an add bar, Active / All / Done segments and the rows (`x-p-mode.png`). The segment is state only (lost on Back).
- Add inside a project: phone More > project > "+" in the header (sheet with project preselected) > I > Add task (4 T + 1 I); desktop inline bar (3 T + 1 I). The created task has no mode on either device.
- Due soon: phone Tasks > "Due soon" segment (2 T); desktop due select with 7 options (3 T; also Overdue, Due today, Today + overdue, This week, Next 7 days, No date).
- Untouched: 2 T / 1 T. Empty here ("Nothing untouched"), because all seeded tasks are new. Not measured with stale data.

---

## 3. Per-screen weight notes

"First screen" = viewport minus the bottom bar (usable 760 px on both: phone 844-84, desktop 800-40 for the time bar). Shares are of that height, from measured element boxes. Rows are shown as seen in the run.

### 3.1 Today
- **Phone (page 5,061 px, 6.0 screens):** title + date 11%, three buttons 6%, three stat tiles 9%, **NOW card 54%** (the current block's tasks, includes tasks with no due date), Overdue heading and first row 13%, then nothing else on the first screen. Order down the page: NOW, Overdue (5), Due today (7), In progress (3), Blocked / waiting (1), Up next (21), Also open (14), Routine. 55 task rows are drawn, 51 are unique: 4 tasks appear twice (NOW card and a section).
- **Desktop (page 2,463 px, 3.1 screens):** title 7%, six stat tiles 8%, add bar 6%, **Schedule column + NOW card 68%** (the Schedule column is all 21 time blocks; the NOW card is 61% of the height with 7-8 rows). Sections below: Overdue (5), Due today (7), In progress (3), Blocked (1). Desktop has no Up next, Also open or Routine in this run.
- **Most used first?** The tasks that are late or due are below the first screen on both devices. What leads is the time-of-day block, which holds the tasks of the current mode (including no-date tasks) rather than what is due.

### 3.2 Tasks (list / board)
- **Phone (page 4,382 px):** title 11%, search + Filters 6%, segments (Open / Due soon / Waiting / Done) 7%, mode chips 6%, **P1 section 65%** (heading "P1 - MUST SHIP 11", rows 70-110 px). P2 19 rows, P3 15, P4 6 follow. The P1 section leads, so the most urgent is on top.
- **Desktop (page 3,648 px):** title + 3 filter selects + search 4%, add bar 6%, **4 columns 83%** (To do 43, In progress, Blocked, Done this week). Cards show priority select only (no status select, no due edit, drag changes status).

### 3.3 Task detail
- **Phone (page 1,696 px, 2.0 screens):** Back bar 7%, title and project link 6%, **Status 9%, Priority 9%, Due 9%, Progress 10%** (all four editable in place), then a 290 px list (Project, Mode, Start, Estimate, Repeats, Tags) = 35% (native pickers and sheets), a sticky green Mark done bar over the bottom. Below the first screen: Note, Checklist, Description, Links, Dependencies, Comment, History. Comment is at 1,324 px.
- **Desktop (page 904 px, 1.1 screens):** the left column (97% of the height) holds status / priority / progress / Complete / Archive / Delete, then Project, Mode, Estimate, Start, Due, Repeats, Tags, Description, Checklist, Links, Waits on, Add a note (comment box, just below the fold). The right column holds Note (25%) and History. Almost everything fits one screen on desktop.

### 3.4 Projects list
- Phone: Active / All pills 6%, then cards of 130-170 px each (about 3 per screen, 6 projects = 1,105 px). Desktop: 3-column grid, the 6 cards take 38% of the screen and the rest is empty. Each card shows done/open, progress, overdue / in progress / blocked / done this week, last activity.

### 3.5 Project page
- **Phone (page 5,079 px, 6.0 screens):** back link + title + "+" 7%, **details form 41%** (Name, Client, Status Active / Paused / Done / Archived, a notes textarea), **stat tiles 19%** (Open 22, Overdue 4, Done this week, Complete), then the Open list begins at y=581, 77% down: **tasks get 23% of the first screen** (a heading and one row). Section order: Open (25 rows, 1,480 px), Recently finished (2,081), Sessions (2,268), Notes (2,372), Code locations (2,716), Activity (2,832).
- **Desktop (page 2,759 px):** the main column (97%) leads with name, status select, a notes box, stats, add bar, then Open (starts at y=321, 58% of the first screen); the right column holds Notes (3 rows and "+ 1 task or archived notes"), Code locations, Activity from the top. So on desktop notes are visible at once; on phone they are 3-4 scrolls down.
- The notes box ("Project notes, scope, links...") on the details form is a different thing from the Notes list.

### 3.6 Notes
- Phone: header + New 11%, search 6%, two chip rows (state / kind, projects) 21% in total, then the list at 65%. Each row is 87 px with title, first line, parent, age. Desktop: title + New note 7%, search + project select + Filter button 5%, two segmented rows 5%, list 72%.
- Note page (phone): "Back to Notes" and a project link on top, an editor. Desktop: "Notes" breadcrumb and project link, the editor and a side area.

### 3.7 Notifications
- Phone: back link and title 18%, then rows of 85-106 px at 11-14% each; about 7 rows on screen of 8 in the run (page 940 px). Desktop: one centred column 90% of the height, the page has a "Settings" link top right, the phone a gear. The list is in time order; kind is shown only by a dot colour and the title prefix.

### 3.8 History and trash
- Phone: tabs 7%, then on Completed a chart card (about 21%) and week groups; Activity list is 1,220 px long. Desktop: tabs 5%, chart 80% of the first screen on Completed.

### 3.9 More (phone) and sidebar (desktop)
- More (1,642 px): Projects group 55% (6 rows and All projects), Modes group 31% (8 rows), Work group (6 rows) and Settings group (2 rows) below the first screen. Projects come first.
- Sidebar (914 px tall at a 800 px window): New task, Today, Tasks, Projects, Notes, History & trash, 8 modes, then Untouched, Weekly review, Timetable, Recovery, Notifications (y=745), Settings (779, at the edge), Connect (813, below the fold at 800 px high). The three most "system" links are the ones cut off.

### 3.10 Timetable, Weekly review, Untouched, Mode page
- Timetable: phone day tabs 7% then one tall list card 76% (blocks 280 px each, 4 visible); desktop 87% table. Weekly review: empty state on a nearly empty screen (3% text). Untouched: 9% note + empty state. Mode page: description card 19%, add bar 7%, segments 7%, rows 45%.

---

## 4. Inconsistencies

Each has its evidence (a shot or a measured value).

### 4.1 Naming
- **Status names:** row sheet and board column "To do" / "In progress", task page and Today row select "Not Started" / "In Progress", Tasks segment "Open", Done list "Done this week" (desktop) vs "Done" (phone). Sheet: `DBG-p-05-row-sheet.png`; task page: `J6-block-with-reason-p-04-after-blocked-tap.png`.
- **Finish a task:** "Mark done" (phone bar and row title attribute), "Complete" (desktop task page button and phone circle aria), toast "Done: ..." (phone), "completed" (history).
- **Un-archive:** "Unarchive" in the phone ... menu, "Restore" on desktop task page; Trash also uses "Restore". Same word, two jobs.
- **Comment vs note:** phone section "COMMENT / What happened?", desktop "ADD A NOTE / Decision, call notes, what happened... (Ctrl+Enter)"; the desktop task page also has a right-column card "NOTE - Add a note" for the page note, so two controls read "Add a note" on one screen. The phone has the same page-note row, named "Note / Add a note".
- **Day plan / Timetable / Schedule:** phone "Day plan", desktop "Day Plan", Today column "SCHEDULE", page "Timetable".
- **New:** "New" (phone notes), "New note" (desktop), "New task" (desktop sidebar), "+" with aria "Add task", "Add task" button, "Add & open".
- **Tasks / Board / Open:** nav "Tasks", route `/board`, phone segment "Open", desktop columns "To do".
- **History tabs** are lowercase in the accessible names ("completed", "activity", "archived", "trash") and capitalised on screen.
- **Same accessible name twice:** the phone "+" tab and the sheet's submit button are both "Add task" (this is why a plain role query hits the tab button first).

### 4.2 Back behaviour
- Phone UI back from a project page goes to `/projects` (list), not to the task you came from; system Back goes to the task (J18).
- Note opened from a project: UI Back goes to Notes, not the project (`J24-note-back-p-04-Back__note_page_.png`); the same on desktop.
- Task page Back is `router.back` (Today, Notifications, or whatever came before); project page and note page Back are fixed. Three behaviours for "Back".
- Notifications reached from the bell: the page's back link says "Today" and the More tab is lit (`J13-notifications-act-p-02-bell__header_.png`).
- Desktop has no Back control on task, project or notification screens; the sidebar is the way back.
- Mode page Active / All / Done is component state, so Back resets it.

### 4.3 Same action, different look or logic
- **Block:** phone sheet requires the reason first (Mark blocked disabled); phone task page saves Blocked first and shows a red prompt; desktop row select saves Blocked and never asks, the reason is a field on the task page (J6).
- **Change a field:** phone row sheet closes after each pick; phone task page keeps every chip live; desktop row uses native selects for status and priority but shows due as plain text.
- **Project / mode picker:** phone task page = native select, desktop = text field with a datalist, new-task form = "New or existing" text field, new-task sheet = chips, new note = chips (phone) or select (desktop).
- **Filter:** phone notes chips filter live; desktop notes needs a select + a Filter button (5 clicks); Tasks search is live on phone and needs Enter on desktop.
- **Delete / remove:** Delete (task), Delete forever (trash), Drop (status), Archive (see J15).
- **Quick add:** desktop shows the syntax hint, phone parses the same syntax with no hint (J3b).

### 4.4 Phone / desktop parity
- **Today content:** desktop 6 tiles, a 21-block Schedule column, 5 sections (24 rows); phone 3 tiles, no schedule list, 9 sections (55 rows).
- **Row due edit:** phone row sheet has due chips; desktop rows cannot edit due without opening the task.
- **Mode on new tasks:** desktop N, the Today bar and the full form assign the current block's mode (Code & Dev, later Outreach & Sales: #51, #53, #58, #62); phone + and phone project add leave it empty (#54-#56, #60), and so does the desktop project-page bar (#61).
- **Comment shortcut:** desktop Ctrl+Enter; phone send arrow only.
- **Day plan:** phone sheet is readable; desktop dialog is clipped (4.9).
- **Phone-only:** tab bar, More, row sheet, Add & open, native pickers, Mark done bar. **Desktop-only:** schedule column, full New task form, board columns, task page with all fields at once, Notes in a side column on the project page.

### 4.5 Duplicates and clutter
- Phone Today draws 4 tasks twice (NOW card + section). Desktop Today draws 1 twice.
- The project page has two "notes" things: a notes textarea in the header form and a Notes section.

### 4.6 Tab highlight and context
- `/projects`, `/projects/*` and `/tasks/*` light the Tasks tab (task page opened from Today or Notifications still lights Tasks); `/notifications`, `/history`, `/modes/*` light More; the Notes tab stays lit on note pages.

### 4.7 Hidden or non-obvious behaviours
- Phone has no Projects row in More (only "All projects"); the Projects list is reached through the project page's back link.
- Notes cannot exist without a project or a task; the New note sheet preselects the first project (Acme Client Portal) alphabetically, not the one in the filter.
- The task page reasons: reason prompt appears only after Blocked is saved.
- Notification read state changes only after the page has stayed open a moment.
- Done and Dropped are not among the phone task page's three status buttons: Done is the green Mark done bar, Dropped is in the row sheet (seen) and, per the inventory, the top-right menu (not opened in this run).

### 4.8 Sticky and overlapping elements
- The green "Mark done" bar overlays the task page's bottom fields and list rows (visible over "Repeats" in `J6-block-with-reason-p-04-after-blocked-tap.png`) and sits above the tab bar.
- Toasts on phone appear over the page header (J5, J6).

### 4.9 Defects seen on the way
- **Desktop Day plan dialog is clipped:** the dialog is 384 px wide (`sm:max-w-sm`) but its content is 561 px wide (`scrollWidth 561 > clientWidth 384`); the left part of labels and rows is cut off ("nated", "o/Close", "ile GST return"). Seen at 1280x800 after 2.5 s. `DBG-d-02-dayplan-settled.png`. Not a measurement artefact.
- **Desktop sidebar is taller than the window** (914 px vs 800): Settings and Connect sit at or below the fold (see 3.9).
- **Time-of-day colouring:** the Today header block and the bottom time bar change colour with the current mode (blue, red); not an error, but the first screen changes through the day.

### 4.10 Seen but not a finding
- All edits measured (status, priority, due, project, comment, block, restore, un-archive, note, add task) saved correctly: confirmed through the app's own MCP read-back after each run.
