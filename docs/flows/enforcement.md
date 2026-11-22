> 22 Nov 2026: built as the hook gate, State copy, release Need and Words (H1 to H10). Where this text differs, `docs/flows/agent-system.md` and `docs/HANDOVER.md` section 3 are right.

# Rules that are enforced, not remembered (draft, 18 Nov 2026)

## How a session works (agreed with Om 18 Nov, after the Fable review in docs/archive/working-system-review.md)
1. **Start / after compaction:** the Work OS hook calls start_work for the folder and puts the Orders and State into the
   session (needs WORK_OS_KEY in the PC's Claude Code settings). The session works from that, not its summary.
2. **While working:** status changes go to Work OS (save_state, tasks, notes). WORK-STATE.md is a copy: the hook
   refuses any hand edit and says to use save_state.
3. **After every save_state / get_state:** the hook writes WORK-STATE.md from the answer in the repo's main folder and
   commits that file alone (not in builder worktrees, not during a merge). So the last State is readable when Work OS
   is down.
4. **Stop:** if files changed and State was not saved, the hook holds the session once and asks for save_state.
5. **Later (step 2+):** `wrap_up`, `hand_over`, `declutter` and `propose_order` as Work OS tools; three exact blocks
   (production push/tag/release without an answered Need, production CLIs not aimed at the test target, WORK-STATE.md).
   The rest of the table below is reference, not a build list (Fable: most of it guesses at shell text).

Om 18 Nov: "I want our enforcement of certain things and directives to get enforced, not drifted." Built from a survey
of the 8 sessions (7 answered) open on Om's PC on 18 Nov (answers in the side-session notes, drift-survey.md), this session's own
mistakes, Om's global CLAUDE.md and the memory rules.

**Principle.** A written rule is advice: it fades in long sessions and after compaction (five of eight sessions named
compaction or long context as the cause of a drift; one ran 3 builders because its summary carried "max 3" instead of
Om's 2). A hook runs every time, whatever the model remembers. So every hard rule becomes one of:
- **Hook** (Claude Code runs it; PreToolUse can refuse a command and say why),
- **Work OS check** (the server refuses),
- **Test / lint** (CI or the e2e run fails).
CLAUDE.md keeps judgment only. Every refusal says what to do instead. All of it ships in the global Work OS plugin
(Om's and Akash's PCs) so a rule changes in one place.

## A. Work state and memory
| # | Rule | Seen drifting | Enforcement |
|---|---|---|---|
| A1 | State lives in Work OS; WORK-STATE.md is only save_state's copy | 5 of 8 sessions kept state in the repo file and skipped save_state (Mailloom, AKAR, Cutroom, Grant Leads, Phase 3) | Global CLAUDE.md line fixed (Om); PreToolUse refuses edits to WORK-STATE.md unless save_state ran in this session; Stop reminds once if code changed and State is unsaved. Superseded by agent-system.md section 10 (H8): the built block refuses hand writes of WORK-STATE.md (an Edit of one line is forwarded to the State), whether or not save_state ran |
| A2 | Handovers are a Work OS note with the delta only, never a pasted TRANSFER.md | AKAR, Grant Leads, orchestrator wrote local TRANSFER.md / _FLEET.md restating history | PreToolUse refuses creating TRANSFER*.md / _FLEET.md; the message names the note tool |
| A3 | "Change Work OS only when Om asks" means don't change *his* data unasked, not "don't log" | Cutroom read it as "don't log" | Rewrite the global line (Om): logging progress, State and notes for your own work is always allowed |
| A4 | Re-read the rules after compaction, not the summary's copy of them | Cutroom ("max 3" from the summary) | SessionStart (source compact) re-injects the hard limits (subagents, models, push rules) from one file |

## B. Diagnose before you report
| # | Rule | Seen | Enforcement |
|---|---|---|---|
| B1 | Never report a guess as a diagnosis ("probably environmental", "CLI not signed in", "it was settling") | AKAR, Phase 3, Mailloom, this session (said builders were working when they had died) | Judgment, plus Stop hook: a final message with "probably/likely/should be/I think" next to "fail/broken/flaky" gets one nudge: "checked?" |
| B2 | Re-run a failure before calling it flaky; name the evidence | Mailloom (34/34 load failure accepted), Grant Leads (stale cache), Phase 3 (shared cookie read as a 401 bug) | Test runner prints "first run failed; rerun passed" so a report cannot hide it |
| B3 | Check what exists before making something new (keys, configs, tools) | Mailloom made an SSH key before reading ~/.ssh/config; Cutroom rebuilt SFX | SessionStart injects the project's tool index (one Work OS note per project: scripts, libraries, assets); builder briefs must link it |
| B4 | Use the browser before declaring a download impossible; don't hand chores to Om | Cutroom (CC0 packs, Kenney 403), Grant Leads ("you come too easy to me") | Judgment; feedback tool counts "asked Om for X" so repeats show |

## C. Secrets
| # | Rule | Seen | Enforcement |
|---|---|---|---|
| C1 | Never print a secret, even into tool output | Phase 3 grepped test passwords; Mailloom relies on discipline | PreToolUse refuses commands that cat/grep/echo *_PASSWORD, *_KEY, *_SECRET, *_TOKEN, WEBHOOK values from .env files or remote envs unmasked; suggests the masked or piped form |
| C2 | Production-linked CLIs need an explicit target; read a value before overwriting it | Grant Leads nearly ran Supabase against production; Phase 3 `vercel env add --force` overwrote two branch-scoped secrets unread | PreToolUse refuses `supabase` without --project-ref, `vercel --prod`, `vercel env add/rm` and `supabase secrets set/unset` unless the target is the test branch/ref, any command naming the production ref, deploy pushes, without an approval marker. Superseded by agent-system.md section 10 (H8): only exact production matches are refused (`vercel --prod`, `vercel env add|rm` on production, `supabase` against a listed target ref), through a release Need; an unlinked supabase call passes |

## D. Git, release, production
| # | Rule | Seen | Enforcement |
|---|---|---|---|
| D1 | No push, tag or release without Om's go for that thing | AKAR treated "push first" as standing approval | PreToolUse refuses `git push` to master/main/deploy, `git tag`, `gh release` unless an approval marker from Om (a Need answered in the app) exists for that repo, valid 1 hour. Superseded by agent-system.md section 10 (H8): a push to a production branch or tag of a production remote, or `gh release`, needs an answered release Need (Yes for 1 hour or 24 hours); a local `git tag` and other pushes pass; there is no approval marker |
| D2 | Only tested work reaches master | (Work OS rule) | pre-push refuses master unless a full e2e pass is recorded for that exact commit |
| D3 | Push to both remotes; scan for secrets and client names first; no Claude trailer where Om forbids it | Orchestrator: two-remotes push is easy to botch; trailer rule | One push script per repo, called by the pre-push hook; commit-msg hook strips/refuses the trailer |
| D4 | Builder briefs name the worktree and branch | Grant Leads builder hit a branch in use | Agent-launch PreToolUse check: a builder brief without a worktree path is refused |

Built (22 Nov 2026): `.githooks/pre-push` runs `npm run check` for a push of dev or master once a clone has set `core.hooksPath` (AGENTS.md, Checks); it names the gate files a push changes, refuses a commit that tracks files under `node_modules`, and refuses a run with no `check:owners ok` line. D2's e2e record and D3's push script are not built.

## E. Subagents and models
| # | Rule | Seen | Enforcement |
|---|---|---|---|
| E1 | Subagent count is Om's call; he allows more than 2 most of the time (Om 18 Nov) | Cutroom ran 3 + judges; this session ran 3 | No refusal. The Agent launch shows the running count in its answer so the session says it in its report |
| E2 | Opus to think, review and do ambitious or unplanned work; Sonnet when a plan and docs exist; Haiku for chores when useful (Om 18 Nov: don't refuse it) | Cutroom all-Opus builders; Mailloom didn't set a model | No refusal. A launch with no model named gets a one-line nudge naming the routing rule |
| E3 | Builders' self-scores and claims are checked by measurement or a judge | Cutroom: self-scores 1-3 above the judge; two disproved claims | The dispatcher's report template requires the evidence (test output, measurement) per claim |
| E4 | Briefs list the assets, libraries and tools to use | Cutroom SFX, Kenney | Brief template field "use these" filled from the project's tool index (B3) |

## F. Working directory and processes
| # | Rule | Seen | Enforcement |
|---|---|---|---|
| F1 | Stop what you start; never stop what you didn't | Cutroom orphan Blender, CPU render; AKAR Postgres left on purpose; this session's builders | Plugin records processes a session starts (PostToolUse on Bash with run_in_background, known servers); SessionEnd/Stop lists leftovers |
| F2 | One heavy job at a time where the machine can't take two (Blender, builds) | Cutroom: two renders, CPU device | PreToolUse refuses a second blender.exe and `--device cpu` (project rule, cutroom) |
| F3 | Scratch goes in the scratchpad, not the repo or home | stray tarballs (Mailloom), _FLEET.md, TRANSFER.md, 40 scripts | PreToolUse refuses new files at repo root not in an allow list; Sunday tidy lists strays |
| F4 | Fixed builder worktree slots; cleanup check at merge | Work OS: 3 stale agent worktrees, old wos-* folders; AKAR non-empty dir after remove | Merge script removes the slot's leftovers and reports |

## G. Windows shell
| # | Rule | Seen | Enforcement |
|---|---|---|---|
| G1 | No Windows paths inside Python/JS string literals in heredocs; no sed for regex edits | Cutroom \t \a 3 times; Grant Leads sed; this session's wsl path quoting | PreToolUse flags `python - <<` with `C:\`/`D:\` and `\t`/`\a` sequences; suggests Edit or forward slashes |
| G2 | Write files as UTF-8 without BOM | Grant Leads Set-Content BOM in .env | PreToolUse flags Set-Content/Out-File on .env*/json without -Encoding utf8NoBOM |

## H. UI
| # | Rule | Seen | Enforcement |
|---|---|---|---|
| H1 | All selects use components/ui/select.tsx | This session shipped a native select in the Inbox | Lint test: a raw `<select` outside the allow list fails the build |
| H2 | New UI checked by eye at 390/1280 light/dark before "done" | AGENTS.md rule | e2e screenshot step per new suite; report must name the shots |

## I. Work OS friction found
- write_note `edits` fail unless the find string matches curly quotes and em-dashes exactly (orchestrator): normalise
  quotes/dashes when matching.
- WORK-STATE.md and Work OS State felt like duplicate bookkeeping (Mailloom, Cutroom): fixed by A1 (one source, one
  copy written by the tool).

## Build order
1. Om edits the global CLAUDE.md lines (A1, A3).
2. Plugin "rules" hooks, tested in D:\wos-hookcheck first: A1, A2, C1, C2, D1, G1 (E1, E2 as nudges).
3. Repo hooks: D2, D3, H1.
4. With the live-sessions plugin: A4, B3, F1, E4.

## How rules improve over time (Om 18 Nov: "a set of practices we can improve over time")
- **One rulebook:** the Orders in Work OS (org, project, person), edited by Om in the app. Every rule has a short id
  (A1, C2...). The global CLAUDE.md only says "start_work, follow the Orders"; the SessionStart hook injects the Orders
  at start and after every compaction, so no session works from a summary's copy.
- **Three strengths per rule:** written (the Orders say it) -> nudge (a hook reminds once) -> block (a hook or Work OS
  refuses and says what to do instead). Every nudge, block and `feedback` is counted per rule id and project.
- **Weekly rules review (one Need for Om):** "A1 was broken 6 times in 3 projects: make it a block?" and "C2 got 4
  pushbacks from Grant Leads: loosen it?". Om taps keep / tighten / loosen; the Orders and hooks change in one place.
  A correction Om gives twice in chat becomes a rule with an id the same day.
- **Adoption card per project:** State age, sessions that started without checking in, blocked WORK-STATE edits,
  stale notes, strays. Shown on the project page and in the weekly review.

## Declutter (Om 18 Nov)
A `declutter` action per project: a button (project ⋯ menu) and an MCP tool. Work OS returns what has grown: Later
lines that are done, duplicated or older than 30 days; Next lines with no task or a finished one; notes with matching
titles or untouched for 30 days; tasks done but open; Needs nobody answered. The session adds what it sees on disk
(extra worktrees and branches, stray files at the repo root, WORK-STATE.md that differs from State). It proposes one
batch (merge, archive, drop, delete-from-disk) as a single Need; on Om's yes it applies the batch and saves State.
Runs on demand, and is triggered by growth, not the calendar (Om 18 Nov: one session working non-stop for 1-3 weeks fills State up): start_work and wrap_up say "Declutter due" when Later passes 25 lines, Next passes 10, a Next line has been done or untouched for 14 days, or the project has notes with matching titles.
