@AGENTS.md

Work OS project: **Work OS** (id work-os). Call start_work for it first.

Full feature and code handover: docs/HANDOVER.md (read it before changing features).

Builders for this repo are permanent slots: A (Opus: access, security, money), B (Opus: features), S (Sonnet:
mechanical work), each with its own worktree, test database and ports. Give a slot related tasks back to back; after a
merge reset its branch to dev, never delete it. Branches: dev first, master is production (deploys 03:00 IST).
Never use `git stash` in any worktree: stashes are shared by all worktrees, so one builder's pop takes another's work.
Commit work in progress on your own branch instead.
