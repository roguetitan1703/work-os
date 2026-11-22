@AGENTS.md

Work OS project: **Work OS** (id work-os). Call start_work for it first.

Start with docs/OVERVIEW.md (one tour of Work OS, with links). Full feature and code handover: docs/HANDOVER.md (read it before changing features). Map of all docs: docs/README.md.

Builders (Sonnet, the builder agent) work in slots A, B and S, each with its own worktree, test database and ports. Give a slot related tasks back to back; after a
merge reset its branch to dev, never delete it. Branches: dev first, master is production (deploys 03:00 IST).
Never use `git stash` in any worktree: stashes are shared by all worktrees, so one builder's pop takes another's work.
Commit work in progress on your own branch instead.
