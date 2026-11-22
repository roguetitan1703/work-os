<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Adding or changing UI

New UI copies its neighbours. A new row, card, setting or button looks and behaves like the ones beside it: same columns,
same button sizes, one button on the right of a row (more controls go in a dialog or the item's own page), the same words
for the same things. Reuse `components/ui/*` and the shared phone pieces in docs/HANDOVER.md section 8. Before calling
UI done, look at it by eye at 390 px and 1280 px (light and dark) next to what surrounds it, and say in the report what
you looked at.

Owned questions: docs/ARCHITECTURE.md lists the questions that have one owner each (which session a call belongs to, which project it is on, whether it is alive, what it owns, whether text reached it, where a stored fact comes from). A change that needs one of these answers calls the owner. A new answer anywhere else is a rejected change. `npm run check:owners` enforces it with a baseline that only goes down. No tool argument carries a fact the server can know.

Checks: `npm run check` runs every static check (scope, words, links, ui, owners), the type check (`next typegen`, then `tsc` with `tsconfig.check.json`) and the unit tests, worker tests included, with no database. It is a heavy job: take a heavy slot (`slot {action: "acquire"}`) before running it and before pushing `dev` or `master`, which runs it. It takes about 3 minutes; from Claude Code run it with the Bash `timeout: 600000`. It must pass before a builder reports and before a merge. A baseline (`tests/ui-baseline.json`, `tests/owners.json`) only goes down; when two branches each lower the same file, the merge runs `npm run check:owners -- --update` once. The check runs the branch's own copy of itself, so a change to a file in `.githooks/gate-files` is read by the reviewer: `git diff dev... -- package.json .npmrc tsconfig.json tsconfig.check.json .githooks scripts/check-links.mjs 'tests/*-check.mjs' node_modules` (`check:owners` and the pre-push hook print a `NOTE:` line for it). A push of `dev` or `master` runs it through the pre-push hook in `.githooks/`, which refuses a run that printed no `check:owners ok` line, a commit that tracks files under `node_modules`, and a remote sha this clone does not have (run `git fetch`). The hook catches mistakes, not a determined author: a merged edit to the hook runs on the push that carries it, so the reviewer reads every change to the gate. Install the hook once per clone, in its main checkout, with an absolute path so that every worktree of the clone runs it: `git config core.hooksPath "$(git rev-parse --show-toplevel)/.githooks"`. Keep the main checkout on `dev`: the hook comes from its working tree, so on an older commit, or after the folder moves, no worktree runs it. Run no `next dev` in the checkout you push from: the type check runs `next typegen` there. `.github/workflows/checks.yml` runs it on GitHub too, but it is not part of the gate until a person has seen its first green run; until then the hook is the gate.

Docs (the map is docs/README.md): docs/OVERVIEW.md is the entry point, one line per feature and workflow with links;
docs/HANDOVER.md is the reference, one section per feature (how it is built, its files and rules); docs/flows/ holds the
few step-by-step paths; docs/ops/ the how-tos for running Work OS; docs/archive/ records that are never updated. A change
updates its feature's HANDOVER section when it changes what the section says, and its flow file if it has one, in the
same commit. A change to deploy, hosting, setup, the worker or the launcher updates its docs/ops/ file (ops/launcher.md
also holds live feature text, Usage and Turbo). A change that adds or removes a feature or workflow also updates its line
in docs/OVERVIEW.md. A user-facing change also adds one What's new entry to `lib/whats-new.ts` (docs/HANDOVER.md
section 8, "What's new"). `npm run check:links` must pass. The reviewer checks all of this.

Agent-facing text (lib/mcp/docs.ts, MCP answers, worker hooks) uses the Words in docs/HANDOVER.md section 3; `npm run check:words` must pass.
