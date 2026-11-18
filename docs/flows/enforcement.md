# Rules that are enforced, not remembered (draft, 18 Nov 2026)

Om 18 Nov: "I want our enforcement of certain things and directives to get enforced, not drifted." Built from a survey
of the 8 sessions open on Om's PC on 18 Nov (answers in the side-session notes, drift-survey.md), this session's own
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
| A1 | State lives in Work OS; WORK-STATE.md is only save_state's copy | 5 of 8 sessions kept state in the repo file and skipped save_state (Mailloom, AKAR, Cutroom, Grant Leads, Phase 3) | Global CLAUDE.md line fixed (Om); PreToolUse refuses edits to WORK-STATE.md unless save_state ran in this session; Stop reminds once if code changed and State is unsaved |
| A2 | Handovers are a Work OS note with the delta only, never a pasted TRANSFER.md | AKAR, Grant Leads, orchestrator wrote local TRANSFER.md / _FLEET.md restating history | PreToolUse refuses creating TRANSFER*.md / _FLEET.md; the message names the note tool |
| A3 | "Change Work OS only when Om asks" means don't change *his* data unasked, not "don't log" | Cutroom read it as "don't log" | Rewrite the global line (Om): logging progress, State and notes for your own work is always allowed |
| A4 | Re-read the rules after compaction, not the summary's copy of them | Cutroom ("max 3" from the summary) | SessionStart (source compact) re-injects the hard limits (subagents, models, push rules) from one file |

## B. Diagnose before you report
| # | Rule | Seen | Enforcement |
|---|---|---|---|
| B1 | Never report a guess as a diagnosis ("probably environmental", "CLI not signed in", "it was settling") | AKAR, Phase 3, Mailloom, this session (said builders were working when they had died) | Judgment, plus Stop hook: a final message with "probably/likely/should be/I think" next to "fail/broken/flaky" gets one nudge: "checked?" |
| B2 | Re-run a failure before calling it flaky; name the evidence | Mailloom (34/34 load failure accepted), Grant Leads (stale cache) | Test runner prints "first run failed; rerun passed" so a report cannot hide it |
| B3 | Check what exists before making something new (keys, configs, tools) | Mailloom made an SSH key before reading ~/.ssh/config; Cutroom rebuilt SFX | SessionStart injects the project's tool index (one Work OS note per project: scripts, libraries, assets); builder briefs must link it |
| B4 | Use the browser before declaring a download impossible; don't hand chores to Om | Cutroom (CC0 packs, Kenney 403), Grant Leads ("you come too easy to me") | Judgment; feedback tool counts "asked Om for X" so repeats show |

## C. Secrets
| # | Rule | Seen | Enforcement |
|---|---|---|---|
| C1 | Never print a secret, even into tool output | Phase 3 grepped test passwords; Mailloom relies on discipline | PreToolUse refuses commands that cat/grep/echo *_PASSWORD, *_KEY, *_SECRET, *_TOKEN, WEBHOOK values from .env files or remote envs unmasked; suggests the masked or piped form |
| C2 | Production-linked CLIs need an explicit target | Grant Leads nearly ran Supabase against production | PreToolUse refuses `supabase` without --project-ref, `vercel --prod`, deploy pushes, without an approval marker |

## D. Git, release, production
| # | Rule | Seen | Enforcement |
|---|---|---|---|
| D1 | No push, tag or release without Om's go for that thing | AKAR treated "push first" as standing approval | PreToolUse refuses `git push` to master/main/deploy, `git tag`, `gh release` unless an approval marker from Om (a Need answered in the app) exists for that repo, valid 1 hour |
| D2 | Only tested work reaches master | (Work OS rule) | pre-push refuses master unless a full e2e pass is recorded for that exact commit |
| D3 | Push to both remotes; scan for secrets and client names first; no Claude trailer where Om forbids it | Orchestrator: two-remotes push is easy to botch; trailer rule | One push script per repo, called by the pre-push hook; commit-msg hook strips/refuses the trailer |
| D4 | Builder briefs name the worktree and branch | Grant Leads builder hit a branch in use | Agent-launch PreToolUse check: a builder brief without a worktree path is refused |

## E. Subagents and models
| # | Rule | Seen | Enforcement |
|---|---|---|---|
| E1 | At most 2 subagents at once unless Om says more | Cutroom ran 3 + judges; this session ran 3 | PreToolUse on Agent counts running subagents; the 3rd is refused with "ask Om or wait" |
| E2 | Opus to think, review and do ambitious or unplanned work; Sonnet when a plan and docs exist (implementation, scanning, mechanical); no Haiku | Cutroom all-Opus builders; Mailloom didn't set a model; AKAR review scan could be Sonnet | Agent-launch check: a model must be named; Haiku refused; a brief that links a plan/design doc and asks for Opus gets a "Sonnet?" nudge |
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
2. Plugin "rules" hooks, tested in D:\wos-hookcheck first: A1, A2, C1, C2, D1, E1, E2, G1.
3. Repo hooks: D2, D3, H1.
4. With the live-sessions plugin: A4, B3, F1, E4.
