# UX audit, stage 2: analysis

Inputs: [crawl-a.md](crawl-a.md) (daily work), [crawl-b.md](crawl-b.md) (setup, connections, Claude Code), [../ui-inventory.md](../ui-inventory.md) incl. Om's notes. Frequencies are inferred (no usage log exists); costs are measured from /today on phone 390 px and desktop 1280 px. "Actions" = taps + swipes + inputs.

## 1. Usage model (inferred)

- **Daily, many times a day:** read Today; add a task; mark done; start a Claude session (Om: the most frequent Claude action); see and answer what Claude waits on; see what's running across projects; open a project; change status, priority or due; check notifications.
- **Weekly:**
  - stop, resume or remove a session (borderline daily);
  - find a task;
  - set a Claude item Next or reorder it;
  - comment, block or move a task;
  - project notes;
  - day plan and weekly review;
  - history;
  - alert tuning.
- **Rare or one-time:**
  - link a folder or repo;
  - create a key or add a device;
  - revoke a key or device;
  - password, passkey, authenticator app;
  - theme and sign out;
  - un-archive;
  - system status.

## 2. Top 5 by frequency × phone cost

Pain = frequency (1–5) × phone actions.

| # | Job | Phone | Desktop | Cause |
|---|---|---|---|---|
| 1 | See sessions and waiting items across 6 projects | **29** (12 taps, 17 swipes, 13 screens); waiting shows counts only ("1 for you") | 23 | No global list (pain 116; crawl B J3, `j3-390-*`) |
| 2 | Start a session, folder linked | **8** (4 taps, 4 swipes, 2456 px = 2.9 screens); 10 with folder picker and message | 7 (9) | Sessions sits below tasks, the Claude work list and Recently finished (crawl B J1a/J1b) |
| 3 | Stop, resume or remove a session | 7–8 (stop = 3 taps + 5 swipes, 3.4 screens); no confirm on stop | 6 | Same buried location (crawl B J2) |
| 4 | Read Today | 3 scrolls; page is 6.0 screens; Overdue appears at 13% of the first screen | 2 | NOW card is 54% of the phone first screen (61% desktop); on desktop the 21-block Schedule plus NOW is 68% (crawl A J1, §3.1) |
| 5 | Anything non-task on the project page | notes 6–7, Claude items 7, code locations 7+, sessions 8 | 3–7 | Phone page ≈ 5.9 screens; details form 41% of the first screen, stat tiles 19%, tasks 23% (crawl A J11a, §3.5) |

Also flagged:
- **Answering with a note:** the item sheet freezes until reopened (crawl B §5.1). This is a defect; a fix is in progress.
- **Weak overview:** the waiting-on-Om overview is cheap (1 tap) but shows counts only (crawl B J4a).

Cost is fine for:
- done (1);
- add task (3 phone / 2 desktop);
- search (3 + input);
- open a project (2);
- bell → waiting item (3 taps, 0 swipes).

## 3. Problems by type

- **Too many steps:**
  - start a session: 8;
  - unlinked folder: 8–10, with nothing saying "link first";
  - un-archive: 6 taps over 5 screens;
  - block with a reason: 3 different flows;
  - password change: 11.
- **Buried by scrolling:**
  - Sessions at 2268 px of a 5079 px phone page;
  - Notes at 2372 px;
  - Code locations at 2716 px;
  - Security at 1251 px in Settings;
  - the Connect Devices tab cut off at x 351–435 of 390.
- **Nesting too deep:**
  - start = More → project → scroll → Sessions → Start → sheet → Start;
  - un-archive is 6 levels deep;
  - Claude item Next/Top exists only in the item sheet.
- **Weighting:**
  - the project page's main action (Start) is 3 screens down;
  - phone Today draws 4 tasks twice (55 rows drawn, 51 unique);
  - Settings has 12 identical-looking switches, two of them always-on or unconfigured;
  - Recovery is 3.56 screens of static text.
- **Spread and duplication:**
  - Start has two buttons with different outcomes (header Start with a picker; row Start without);
  - linking has two flows (suggestion row, "Add a folder" sheet);
  - waiting on Om appears in 4 places, never as one list;
  - "Claude" names 5 different things;
  - push has 3 homes;
  - creating a task has 9 paths;
  - the schedule appears in 5 places.
- **Missing overviews:**
  - all sessions across projects;
  - a global waiting list with the question text;
  - Claude status on Today;
  - global search (it covers Tasks only);
  - "what changed today" as a view;
  - a per-project overview.
- **Back and navigation:**
  - project Back always goes to the Projects list;
  - note Back goes to Notes, not the project;
  - Notifications' Back is labelled "Today";
  - leaving Connect from a tab takes 4 Backs;
  - the Tasks tab is lit on project pages;
  - desktop has no Back control.
- **Naming:**
  - Tasks / Board / Open / To do / Not Started;
  - Mark done / Complete / Done;
  - Unarchive / Restore;
  - Day plan / Schedule / Timetable;
  - Alerts / Notifications;
  - Waiting on you / for you / needs you / Answered;
  - Devices / Computer;
  - 12 unlabeled switches.
- **Phone/desktop parity:**
  - due-date edit, the mode on new tasks, the quick-add hint, the clipped Day plan dialog, the unreachable sidebar theme and sign-out, and Connect tabs cut off on phone;
  - Notes filter: 3 actions on phone vs 5 on desktop;
  - Tasks search is live on phone but needs Enter on desktop;
  - Weekly review is a centered dialog on phone.
- **Missing confirms:**
  - Stop, Remove, Unlink, Resume and Sign out have none;
  - revoke key, revoke device and remove passkey use native `confirm()`;
  - desktop saves "Blocked" without asking for a reason;
  - a stuck session is shown only as text.

## 4. Root causes

1. **The project page is a task list first.** Sessions, Claude items, notes and code locations are stacked below or beside it, making a phone column of about 5.9 screens.
2. **Claude features are per-project only.** There is no cross-project layer: no global sessions list, no waiting list, no "Start Claude" outside a project, and no Claude status on Today or the sidebar.
3. **Navigation is weighted by build order, not by use.**
   - 8 of the 20 sidebar links are modes.
   - Recovery, Timetable and Review are top-level.
   - Projects has no row in phone More.
   - More is a 47-row catch-all.
   - Settings and Connect are 2 taps plus 2 swipes away on phone.
   - On desktop they sit below the fold (sidebar 914 px vs 800 px window).
4. **Connect is a second Settings.**
   - Push appears in 3 places.
   - Connect Alerts is read-only and links back to Settings.
   - Connect has 4 different labels.
   - One-time key and device jobs sit beside daily ones.
5. **Phone and desktop are separate layouts per page.** Controls were added to one and not the other (§3 parity).
6. **Actions live in detail sheets, not on rows.** Claude items have no row controls. Answering is a note box plus a separate "Answered" button.
7. **No shared grammar** for Back (3 models), naming (12+ verbs), confirms (native vs sheets) or forms (inline vs sheet).
8. **Today is built around the time block, not around what needs attention.**

## 5. Must-keep strengths

- 1-tap done with Undo.
- Desktop `N` quick add and the inline bar.
- Phone `+` quick add with chips and typed syntax.
- The bell path to a waiting item (3 taps, 0 swipes, with the question text).
- Inline selects on desktop rows and the "…" sheet on phone rows.
- Task page with all four fields on the first phone screen.
- Live Tasks search with `#ref`; P1 leads the list.
- The start sheet: clear label, optional message, and a toast saying where the session appears.
- Honest session state text.
- One-tap same-repo Link.
- Project cards showing overdue / in progress / blocked / last activity.
- Notes in the desktop project page's right column.
- Trash with 30-day restore.
- Login: autofocused password and passkey autofill.
- Alerts claimed before sending (each alert sent once).

## 6. Constraints for the redesign

- **From Om:** weigh by what he does, not by screen count. Directions to weigh:
  - a global "Start Claude" in 2 taps;
  - a project overview page;
  - one Claude Code area (keys, devices, all sessions, waiting).
- **Must stay reachable:**
  - tasks and projects;
  - notes;
  - history, trash, archive and Untouched;
  - weekly review and Timetable;
  - the 8 modes;
  - the 8 alert kinds;
  - Discord;
  - the Claude connector (30 tools);
  - keys, devices and code locations;
  - sessions and Claude items (queue, next, reorder, answer, states);
  - security (password, passkeys, authenticator app, email reset);
  - theme.
- **Platform:**
  - PWA with no browser refresh;
  - phone is below 768 px, switched by CSS, and phone work must not change the desktop view;
  - tap targets at least 44 px and text at least 16 px;
  - sheets carry `data-sheet`;
  - the tab bar has 5 slots and `+` stays one tap;
  - state that must survive Back lives in the URL;
  - push needs a real OS prompt;
  - Next.js here has breaking changes (AGENTS.md).
- **Session mechanics:**
  - Start only creates a job; the worker on the PC launches the session;
  - starting needs a device, a linked folder and a project;
  - code locations (git remote) are what make folder suggestions appear;
  - "Next" exists only for queued items, and Answered only clears the flag.
- **Defects not to carry over** (fixes in progress): the item sheet freeze, the desktop sidebar footer under the 40 px bar, the clipped Day plan dialog (384 px wide, 561 px content), and the unlabeled switches.
- **Not measured:**
  - real push;
  - a real worker launch;
  - Face ID;
  - Discord live status;
  - saving a code location;
  - dark theme;
  - the sheet freeze on production;
  - a real phone (390 px was emulated).
