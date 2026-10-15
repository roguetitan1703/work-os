# UX audit, crawler B: setup, connections and everything Claude Code

Measured by running the app, not by reading code. Input for a later analysis; no redesign is proposed here.

## How this was measured

- App: `next start` build of master (`.next` built 11:01 on 2026-10-15), port 3432, throwaway MongoDB (single-node replica set, port 27132, DB `workos_uxb`). Discord, cron and the real worker were off. For the later runs a local SMTP sink caught the mail and a throwaway `CRON_SECRET` was set. Nothing real was reachable.
- Seed: 6 projects (AKAR 25 open tasks, Brahmasuite 25, Delpat Site 25, PMS 15, Anaspure 5, Work OS 5), code locations on 5 of them, 15 Claude items (3 waiting on Om, 2 active, 1 next, 4 queued, 2 blocked chains, 1 done), 2 devices, 9 reported folders (some linked, some same-repo suggestions, one with no repo), sessions in running / starting / stopped / closed / failed / stuck-starting states.
- Browsers: Playwright Chromium, desktop 1280x800 (mouse), phone 390x844 at 2x with touch. Phone/desktop is a CSS switch, so "phone" is the real phone layout.
- Counting rules:
  - **tap/click** = one tap or click (a native `confirm()` counts as one more action).
  - **input** = one text field filled.
  - **swipe** = `ceil(distance / (0.8 x viewport height))`. The distance is the real scroll needed to bring the target to about a third of the way down the screen. It is shown in px and in screens.
  - **screens** = distinct pages or sheets seen, including the starting page.
  - All paths start on `/today` (the landing page), unless a row says "from the project page".
- Screenshots: `.scratch-mongo/ux-shots/b/` (outside git). File names are `<job>-<390|1280>-<step>.png`. Probes are `probe-*.png` and `w-*.png`.
- Not executed (and why): turning push on for a device (headless Chromium reports "Blocked"; a real OS permission prompt cannot be driven); passkey with Face ID (a virtual authenticator approved it); starting a real session (a Start only creates a job row for the worker); saving a code location.
- The project page has tasks above Sessions. Scroll counts depend on how many open tasks there are (25 here, so a busy project). Smaller projects are shown where it mattered.

## 1. Jobs table

Actions = taps/clicks + swipes + inputs. "From project" means counted from the project page, so add 2 taps (phone: More, project; desktop: Projects, project) for the landing-page figure.

| # | Job | Phone: taps / swipes / inputs / screens (px scrolled) | Desktop: clicks / swipes / inputs / screens (px) | Worst |
|---|---|---|---|---|
| 1a | Start session, folder already linked, row Start | 4 / 4 / 0 / 4 (2456 px = 2.9 screens) | 4 / 3 / 0 / 4 (1526 px = 1.9 screens) | phone 8 actions |
| 1b | Start via the Sessions header Start, 2 folders (picker) + typed first message | 5 / 4 / 1 / 4 (2397 px) | 5 / 3 / 1 / 4 (1487 px) | phone 10 |
| 1c | Start, folder not linked, same-repo suggestion (Link, then Start) | 5 / 3 / 0 / 4 (1910 px) | 5 / 2 / 0 / 4 (864 px) | phone 8 |
| 1d | Start, nothing linked, no suggestion (Add a folder, search, pick, Start) | 6 / 3 / 1 / 5 (1823 px) | 6 / 2 / 1 / 5 (756 px) | phone 10 |
| 2a | Stop a running session | 3 / 5 / 0 / 3 (2895 px = 3.4 screens) | 3 / 3 / 0 / 3 (1428 px) | phone 8 |
| 2b | Resume a stopped session | 3 / 4 / 0 / 3 (2685 px) | 3 / 3 / 0 / 3 (1428 px) | phone 7 |
| 2c | Remove a stopped session from the list | 3 / 5 / 0 / 3 (2790 px; from project: 1 tap) | 3 / 3 / 0 / 3 (1428 px) | phone 8 |
| 3 | See running sessions across all 6 projects (no global list exists) | 12 / 17 / 0 / 13 | 12 / 11 / 0 / 13 | phone 29 |
| 4a | See which Claude items wait on Om, all projects (badge counts only) | 1 / 0 / 0 / 2 | 1 / 0 / 0 / 2 | glance, counts only |
| 4b | Answer a waiting item, no note, via the notification inbox | 3 / 0 / 0 / 3 | 3 / 0 / 0 / 3 | 3 |
| 4c | Answer a waiting item, no note, via the project page | 4 / 3 / 0 / 4 (1986 px) | 4 / 2 / 0 / 4 (1176 px) | phone 7 |
| 4d | Answer with a typed note, inbox path | 4 / 0 / 1 / 3, then the sheet freezes (see 5.1) | 4 / 0 / 1 / 3, same | blocked until close and reopen |
| 5a | Mark a queued item "next" | 4 / 4 / 0 / 4 (2207 px) | 4 / 3 / 0 / 4 (1384 px) | phone 8 |
| 5b | Reorder: move a queued item to Top (one step per tap) | 4 / 4 / 0 / 4 (2494 px) | 4 / 3 / 0 / 4 (1418 px) | phone 8 |
| 6a | Create a Claude Code key for a new repo | 4 / 2 / 1 / 3 (+1 tap "I saved it") | 3 / 0 / 1 / 2 (+1) | phone 7 |
| 6b | Add a device | 4 / 3 / 1 / 3 (2 for More, 1 sideways for the tab strip) | 3 / 0 / 1 / 2 | phone 8 |
| 6c | Link a new repo to a project (Code locations) | 3 / 4 / 0 / 3 and then about 1 input + 1 save (not executed) | 3 / 0 / 0 / 3 and then about 1 + 1 | phone 9 |
| 6d | Revoke a key / a device (native `confirm()`) | 1 + confirm each, from the tab | same | 2 each |
| 7a | Is anything working? Connect Overview (alerts, Discord) | 2 / 2 / 0 / 3 (+1 tap for the Alerts tab detail) | 1 / 0 / 0 / 2 (+1) | phone 4 |
| 7b | Is push working on this device? Settings > This device | 2 / 2 / 0 / 3 | 1 / 0 / 0 / 2 | phone 4 |
| 7c | Turn one alert kind off (Overdue) | 3 / 2 / 0 / 3 | 2 / 0 / 0 / 2 | phone 5 |
| 8a | Change the password | 4 / 4 / 3 / 3 | 3 / 2 / 3 / 2 | phone 11 |
| 8b | Set up a passkey | 3 / 4 / 0 / 3 (+ OS prompt) | 2 / 2 / 0 / 2 (+ OS prompt) | phone 7 |
| 8c | Turn on the authenticator app (QR, code, recovery codes) | 5 / 4 / 1 / 3 (+ switch to the authenticator app) | 4 / 2 / 1 / 2 | phone 10 |
| 9a | Sign in with password | 1 / 0 / 1 / 2 | 1 / 0 / 1 / 2 | 2 |
| 9b | Recover access: forgot password, email link, new password, sign in again | 4 / 0 / 3 / 5 (+ mail app) | same | the mail app is outside Work OS |
| 9c | Sign in with a passkey | 0 taps with the virtual authenticator (browser autofill ran at page load); real phone: field focus + chip + Face ID, not measured | same | not measurable here |
| 9d | Sign in with the authenticator app on | 2 / 0 / 2 / 3 (password, Sign in, code, Verify) | same | 4 |
| 10a | Check system status (Connect Overview) | 2 / 2 / 0 / 3 | 1 / 0 / 0 / 2 | phone 4 |
| 10b | Change the theme | 3 / 4 / 0 / 3 (Settings > App, last group) | sidebar toggle blocked (see 5.2); fallback via Settings 2 / 2 / 0 / 2 | phone 7 |
| 10c | Sign out | 3 / 4 / 0 / 4 (last row of Settings) | sidebar icon blocked (see 5.2); fallback via Settings 2 / 2 / 0 / 3 | phone 7 |

### Headline numbers

- Worst by actions on phone: **J3 see running sessions everywhere = 29** (12 taps, 17 swipes, 13 screens, because only the project page shows sessions); **J8a password = 11**; **J1b / J1d / J8c = 10**.
- Starting a session from the landing page: **8 actions on phone (4 taps + 4 swipes), 7 on desktop** when the folder is linked; **10 / 9** when a folder has to be added. About 2.9 screens of scrolling on a 25-task project is the biggest part; the project page's Sessions block sits below the task list, Claude's work list and Recently finished.
- Stop, Resume, Remove need 3 taps and 4-5 swipes on phone, because the session rows sit below the folder list which sits below everything else.
- A global "what runs now" list and a global "what waits on Om" list do not exist. The nearest things are a badge count per project and a notification inbox entry per waiting item.
- Everything in Connect and Settings is 2 taps plus 2 swipes deep on phone (More is 1.95 screens tall; Settings and Connect are its last two rows).

## 2. Per-job step paths

Phone first, then desktop where it differs. Numbers are `step: action (screen/shot)`. Shots use the job id, e.g. `j1a-390-04.png`.

### J1a. Start a session, folder already linked (AKAR)

Phone (`j1a-390-01..06`): 1 tap More tab. 2 tap AKAR in the More list (the Projects list only appears after the project page's Back). 3 scroll 2456 px (about 4 swipes) past the 5-row details card, 4 stat tiles, 25 task rows, Recently finished and Claude's work list (4 groups) to Sessions. 4 tap the small "Start" next to the folder (`j1a-390-05`). 5 sheet "Start AKAR": text "AKAR (master) on Om-Desktop", optional "First message" box, black Start button; tap Start. A toast says "Starting AKAR on Om-Desktop. It appears in the Claude app in a few seconds."
- The new session row appears below the folder list as "starting" in blue, with no scroll jump.

Desktop (`j1a-1280-*`): Projects (sidebar), AKAR, scroll 1526 px, click Start, click Start. Sessions is at the bottom of the left column; the right column (Notes, Code locations, Activity) is above the fold.

### J1b. Header Start with two linked folders and a message

From the project page: scroll 2397 px (phone) / 1487 px (desktop), tap the big black "Start" in the Sessions header, a radio list "Folder" appears (2 folders), tap the second, type in "First message", tap Start. 3 taps + 1 input + swipes; add 2 taps to get there. The header Start is the only place a folder can be picked; the row Start skips the picker.

### J1c. Folder not linked, same-repo suggestion (Brahmasuite)

More, project, scroll 1910 px (phone), the suggested folder shows "Om-Desktop · same repo as this project" with a Link button, tap Link (row becomes a linked folder with Start/Unlink, no scroll needed), tap row Start, tap Start in the sheet. 5 taps + 3 swipes. Nothing on the page says "link first, then start": the suggestion row looks like a folder row with a different button.

### J1d. Nothing linked, no suggestion (Delpat Site)

More, project, scroll 1823 px, tap "Add a folder" (sheet "Add a folder": a Computer select defaulting to the first device, a search box), type "scratch", tap the result (it links and closes the sheet, toast "Linked scratch-notes"), tap row Start, tap Start. 6 taps + 1 input + 3 swipes. If the folder is on the second device, add 1 select tap. With no repo code location on the project, the project shows "No repos linked. Claude Code uses these to find this project..." above the same block.

### J2. Stop / Resume / Remove

- Stop (J2a): More, project, scroll 2895 px (3.4 screens, the session rows are below the folder list), tap Stop. No confirmation. The button gives no state change until the worker answers (toast "Stopping…").
- Resume (J2b): same path, tap Resume (labelled, no confirm), row becomes "starting".
- Remove (J2c): tap Remove (labelled, no confirm). The row disappears; the doc is kept hidden.
- Row text states seen: "open on Om-Desktop" (green), "starting" (blue), "stopped", "closed", "no news from its computer" (orange, when the device has been quiet for 3 minutes), "Waiting: check the terminal on Om-Desktop" (stuck starting after 60 s). On phone each row is up to 3 lines and some actions wrap under the text.

### J3. See all running sessions across projects

There is no cross-project list. Each of 6 projects: (back) tap the "Projects" back link, tap the project row, scroll 1000-2900 px to Sessions. Phone: More, then 6 x (back, project, 2-5 swipes) = 12 taps, 17 swipes, 13 screens. Desktop: Projects (sidebar), project, 1-3 swipes, repeated: 12 clicks, 11 swipes. Connect > Devices lists the devices ("seen 5 minutes ago") but not their sessions or folders. Today has no Claude or session content. See `j3-390-*.png`.

### J4. Waiting on Om

- 4a overview: More on phone (Projects on desktop) shows "1 for you" next to AKAR, Anaspure and PMS (`j4a-390-02.png`). It does not say what the question is. One tap, no scroll.
- 4b inbox: tap the bell (phone) or Notifications (sidebar), tap the "Claude needs you: C9 Which logo..." entry, which opens the project and the item sheet directly (`j4b-390-03.png`), tap Answered. 3 taps, 0 swipes. The inbox entry shows the question text under the title. This is the shortest path and the only one without scrolling.
- 4c project path: More, project, scroll 1986 px to "Waiting on you · 1" (top group of Claude's work list, so closer than Sessions), tap the item, tap Answered. 4 taps + 3 swipes.
- 4d with a typed note: type in "Add a note for Claude", tap Add. The note is saved, but the sheet's buttons (Answered, Up/Down/Top, Next, State) stay disabled until the sheet is closed and reopened (5.1). "Answered" itself only clears the flag; the answer text goes through the note field as a separate step.
- Answered only clears the waiting flag. Whether and when Claude sees the note depends on a session reading the item (not tested).

### J5. Mark next / reorder

- 5a: More, project, scroll 2207 px to the Queued group, tap the item, tap the "Next" toggle (shows "Next: on"). Next exists only for queued items.
- 5b: tap the item, tap Top (or Up/Down). One tap moves one step in project order; Up/Down can move more than one visible step because the list shows groups. Disabled buttons: Top on the first item.
- Both live in the item sheet only; the list rows have no controls.

### J6. Keys and devices

- 6a key: More, scroll 798 px (2 swipes: Connect is the second-to-last row), Connect, tab "Claude Code" (visible without sideways scroll), type a name in "Name, e.g. Laptop · work-os", tap Create. A sheet shows the key and a ready-to-paste `claude mcp add ...` command, with two copy buttons and "I saved it" (`j6a-390-07.png`). The key is not linked to any project; that is 6c.
- 6b device: same road, tab "Devices" is partly off-screen at x 351-435 of 390 px (one sideways swipe), type a device name, tap Add. A sheet shows the device key and a command for the PC.
- 6c link a repo: More, project, scroll 2208 px (Code locations is near the bottom on phone; on desktop it is in the right column above the fold), tap "+ Add", form fields: Git remote, Folder (optional), Branch (optional), "Or a folder path".
- 6d revoke: the trash icon asks with a browser `confirm()` (native dialog), for both keys and devices.

### J7. Alerts, Discord, push

- 7a: More, scroll, Connect lands on Overview: cards Claude chat ("Connected · last used 25 minutes ago"), Claude Code ("Not set up · No keys yet" when none), Discord bot ("Not set up · Discord env vars missing"), Alerts ("Not set up · CRON_SECRET missing", later "Running · Last check 5 seconds ago · Checks every 15 min"). The Alerts tab adds "sent 2 alerts". Push state is not on Connect.
- 7b: Settings > This device shows "Notifications on this device" switch, "0 devices receiving push", "Send test". Tapping the switch in headless Chromium shows "Blocked. Allow notifications for Work OS in the phone settings, then come back."
- 7c: Settings, Overdue switch is within the first 0.9 screens below the top, so no scroll beyond reaching Settings. Saves on tap, no Save button, no toast checked.
- "Is Discord working?" has one answer in two places: Overview card text and the Discord tab status; neither shows a last-success time.

### J8. Security

- 8a password: More, Settings, scroll 1251 px to Security, "Change" opens inline fields: Current password, New password (10+), New password again, "Change password" button. Toast: "Password changed. Other devices were signed out." Afterwards the login screen is needed on every other device.
- 8b passkey: scroll to Security, optional name input (pre-filled "Windows PC · Chrome"), tap Add passkey, OS prompt. Toast "Passkey added. You can now sign in with it." The row shows "not used yet".
- 8c authenticator app: Turn on shows QR and secret, type the 6-digit code, tap Confirm, recovery codes (10, two columns) with "Copy all" and "I saved them". "Not shown again."
- Sign-in: the password field is autofocused, 1 input + 1 tap. With the authenticator app on, a second screen asks for the code (recovery code goes in the same box: "Lost your phone? Enter one of your recovery codes instead").
- Recovery (9b): login, "Forgot password?" (a text link under the button), "Email me a reset link" (no input, the link goes to the owner address only), open the mail, the reset page asks for the new password twice, then lands on `/login?reset=done` and asks for the password once more. In-app: 4 taps, 3 inputs, and a mail app in between. With no email set up on the server the reset cannot work; Settings shows "Off: set EMAIL_HOST ... Password reset by email needs it."

### J10. Status, theme, sign out

- Status: no page named Status. Settings > App has a "System status" row that opens `/connect` (Overview). 10a = 2 taps + 2 swipes on phone.
- Theme: phone only via Settings > App (last group). Desktop has a sidebar toggle but it cannot be clicked (5.2).
- Sign out: phone only via the last row of Settings. Desktop sidebar icon is blocked (5.2); fallback via Settings is 2 clicks + 2 swipes. No confirmation.

## 3. Per-screen weight notes

Page height is `scrollHeight / viewport height`.

| Screen | Phone | Desktop |
|---|---|---|
| `/more` | 1.95 screens; 3 Claude-badged project rows among 6 projects + All projects, 8 modes, 6 work rows, then Settings, Connect at the very bottom (about 798 px down) | not linked (URL only) |
| `/projects` | 1.42 | 1.0 |
| `/projects/[id]` (25 tasks) | 5.86 screens. First screen: header, then the Name/Client/Status/notes edit card (4 rows, about 0.7 screens), stat tiles at about 1.0, first task at 0.73-1.0, Claude's work list at about 2.1-2.4, Sessions at about 3.3 | 2.77 screens. Left column: details, 4 tiles, quick-add bar, tasks. Right column: Notes, Code locations, Activity, all above the fold. Claude's work list and Sessions are at the bottom of the left column |
| Claude item sheet | Bottom sheet: id, kind chip, state; title; amber "Claude is waiting on you" box with Answered; Why; Done when; State and Kind selects; Up/Down/Top; Next; note input; Log. About 2 screens on phone | centered dialog, same content |
| Sessions block | Two stacked cards with no separating sub-heading: folders (Start, Unlink or Link), then session rows. Folder name truncates ("AKAR-wt/debt-3 (…") | same, no truncation |
| `/connect` Overview | 1.0; 4 status cards | 1.0 |
| `/connect?tab=chat` | 1.14 | 1.05 |
| `/connect?tab=code` | 1.0 (keys list + Create row + 2 collapsed disclosures) | 1.0 |
| `/connect?tab=devices` | 1.0 | 1.0 |
| `/connect?tab=discord` | 1.72, mostly setup instructions (env var list, curl commands) | 1.29 |
| `/connect?tab=alerts` | 1.0 | 1.0 |
| `/connect?tab=reference` | 2.5 (30 tool names, each with read-only/writes) | 2.58 |
| Connect tab strip | 7 tabs; Overview, Claude chat, Claude Code visible, Devices cut at the edge (351-435 of 390 px), Discord, Alerts, Reference off-screen | all 7 visible |
| `/settings` | 2.56 screens: This device (2 rows + Send test), Notifications (12 switches in one card), Security (passkeys, authenticator, password, email), App (theme, 2 links, Sign out) | 2.35 |
| `/notifications` | 1.36 | 1.13 |
| `/recovery` | 3.56, static text | 2.6 |
| Login | One card: password, Sign in, "Forgot password?", "or", "Sign in with passkey" | same |
| `/today` | 2.75, no Claude or session content | 1.38 |

What draws the eye:
- Project page, phone: the project's own edit form (Name, Client, Status) and four stat tiles, not tasks and not Claude. The one dark filled button on the page that is not the global "+" is "Start" in Sessions, but it is 3 screens down.
- Settings: 12 switches (1 in This device, 11 in the Notifications card), 8 alert kinds that look identical; "In-app inbox" and "Discord DMs" look like switches but are always-on or not configured (pale green).
- Connect: the segmented tab strip; the Overview cards use small coloured status text.
- Item sheet: the amber box.

Buried:
- Sessions (start/stop/resume), Claude's work list and Code locations on phone.
- Push per device (Settings first group), Discord status (Overview text only), Devices (a tab 4 of 7).
- Theme, Sign out and Security: the last or middle of a 2.56-screen page, 2 taps + 2 swipes from anywhere.

## 4. Duplication and spread

| Thing | Where it appears | Notes |
|---|---|---|
| Push notifications | Settings > This device ("Notifications on this device" switch, "N devices receiving push", Send test); Settings > Notifications ("Phone notifications" switch); Connect > Alerts (status, no push info) | Two push switches in one page, one per device, one global. Neither says which does what from its name |
| Alert on/off | Settings > Notifications (switches); Connect > Alerts (read-only "When alerts fire" + link "Settings" to the same page) | Settings > Connect > Settings loop |
| Alert status | Connect Overview Alerts card; Connect > Alerts "Last run" | Same data twice |
| Connect | More row; desktop sidebar; Settings row "System status"; Settings row "Claude, Discord & alerts setup"; Overview cards as links to each tab | One page, 4 entry labels |
| Settings | More; sidebar; Notifications page gear; Connect > Alerts "Settings" link | |
| Theme toggle | Settings > App; desktop sidebar footer | The sidebar one is not clickable at 800 or 1000 px tall (5.2) |
| Sign out | Settings > App; desktop sidebar footer (icon, title only) | Same |
| Start a session | Sessions header "Start" (picker); each linked folder row "Start" (no picker) | Different buttons, different outcomes |
| Linking a folder | "Link" on a suggestion row; "Add a folder" sheet (search) | Two flows for the same result |
| Folder-to-project | Project page Sessions; project page Code locations (git remote); Connect > Devices (shows devices only) | Code locations is what makes a suggestion appear, but sits further down |
| Waiting on Om | Project's Claude list group "Waiting on you"; "N for you" badge in More list and Projects list; "Claude needs you" notification; Settings > Notifications switch "Claude needs you" | No single list |
| Claude Code key | Connect > Claude Code (create/rotate/revoke); Connect Overview card; Reference/Setup disclosure "Connect this PC" | |
| Device add | Connect > Devices (Add); project Sessions note linking to Connect > Devices | |
| Claude items vs Claude chat vs Claude Code | Tab "Claude chat" (connector), tab "Claude Code" (keys), project block "Claude's work list" (items), More badge "N for you", Sessions | Four different things share the word Claude |
| Notifications inbox | bell (phone headers), More row, sidebar, Settings gear | |
| Tasks "+" | tab bar +, sidebar New task, project header +, project quick-add | Not Claude-specific, listed because "+" is not a Claude start |

## 5. Inconsistencies

### 5.1 Behaviour

- **Item sheet freezes after one change.** In the Claude item sheet, after Add (note), Next, or any State/Kind change, every control stays disabled (pending) until the sheet is closed and reopened. The change itself is saved (the log shows "note added"). Seen on desktop and phone in this build (`j4d-*-05.png`). Worth checking on production before treating as a sandbox artifact.
- **Answering takes two steps** that do not know each other: a note box (Add) and an "Answered" button.
- **Stop, Remove, Unlink, Resume have no confirm; Revoke key and Revoke device use a native browser `confirm()`**; passkey remove also uses `confirm()`. Sign out has none. Stop kills a session on the PC with one tap.
- **Native dialogs vs sheets.** Revoke uses a browser dialog; every other flow uses an app sheet or inline form.
- **Back differs by entry.** Settings and Connect say "More"; project page says "Projects" even when opened from More, from a notification or from a project link; Notifications says "Today" whichever bell was tapped. Connect tabs push history: Back from the Devices tab went to Code, then Chat, then Overview, then `/today` (4 backs).
- **Tab highlight and place.** `/projects/*` lights "Tasks" in the bottom bar although it was reached from More.
- **Add folder** links and closes in one tap; **Link** (suggestion) links but stays; both are "Link" actions with different aftermath.
- **Sheet vs inline:** password change, passkey, authenticator are inline in the card; keys and devices are sheets; Add a folder is a sheet; Code locations Add is inline.
- **Key reveal vs recovery codes:** "I saved it" (key, device) vs "I saved them" (recovery codes).
- **Staleness is shown only on some rows:** devices show "seen N minutes ago" on Connect > Devices, but in the Sessions block a device quiet for more than 3 minutes shows only as session text "no news from its computer" (orange); folder rows say "offline".

### 5.2 Parity and reachability

- **Desktop sidebar footer is unreachable.** At 1280x800 and 1280x1000 the theme toggle and the sign-out icon (title only, no label) sit under the fixed 40 px time-block bar; a mouse click is intercepted by the bar. Reachable only through Settings (2 clicks + 2 swipes). Screens: `probe-sidebar-bottom-1280.png`, `probe-sidebar-1280x1000.png`, `j10b1-1280-02.png`.
- **Phone has no cross-project anything for Claude**, but neither does desktop; the only parity gap is volume: the same project page needs 2.9 screens of scrolling on phone and 1.9 on desktop to reach Sessions.
- **Connect tab strip:** desktop shows all 7 tabs; phone shows 3 and a cut-off fourth. The Devices tab (the one needed to add a computer) is off the first view.
- **Code locations:** above the fold on desktop (right column), 2.6 screens down on phone.
- **Today and the sidebar show no Claude status** on either surface (no running-session count, no waiting-on-Om badge). Only the bell badge changes.
- **Settings > This device** (install, push) is meaningful per device but sits in the same page as account-wide switches.

### 5.3 Naming

- "Connect" (nav) vs page title "Connect: Claude, Discord and alerts" vs Settings rows "System status" and "Claude, Discord & alerts setup" (same destination, different words).
- "Alerts" (Connect tab) vs "Notifications" (Settings group, inbox, switch cards) vs "Phone notifications" vs "Notifications on this device".
- "Devices" (tab) vs "Computer" (select in Add a folder) vs "computer" ("no news from its computer") vs device name in rows.
- Verbs for ending or removing: Stop, Remove, Unlink, Revoke, Delete (tasks), Turn off, Answered.
- Verbs for adding: Create (key), Add (device), Add a folder, Link (suggestion), Add (note), Add passkey, Add (code location), Turn on (authenticator).
- "Waiting on you" (group) vs "Claude is waiting on you" (box) vs "for you" (badge) vs "Claude needs you" (notification and Settings switch) vs "Answered" (button).
- Item state words: queued, active, blocked, done, dropped (State select) vs group names Waiting on you, Active, Queued, Blocked, Next up, plus a separate "Next: on" toggle.
- Unlabeled switches: all 12 `role=switch` controls on Settings have no accessible name (the label is plain text next to them). The sign-out icon is labelled only by `title`.

## 6. What was left unmeasured

- Real push opt-in and delivery, real Face ID passkey prompt, the worker actually launching a terminal, Discord live status.
- Saving a code location (form only).
- The effect of the item sheet freeze on production data.
- Dark theme (screenshots are light).
