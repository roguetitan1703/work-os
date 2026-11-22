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

Docs (the map is docs/README.md): docs/OVERVIEW.md is the entry point, one line per feature and workflow with links;
docs/HANDOVER.md is the reference, one section per feature (how it is built, its files and rules); docs/flows/ holds the
few step-by-step paths; docs/ops/ the how-tos for running Work OS; docs/archive/ records that are never updated. A change
updates its feature's HANDOVER section when it changes what the section says, and its flow file if it has one, in the
same commit. A change to deploy, hosting, setup, the worker or the launcher updates its docs/ops/ file (ops/launcher.md
also holds live feature text, Usage and Turbo). A change that adds or removes a feature or workflow also updates its line
in docs/OVERVIEW.md. A user-facing change also adds one What's new entry to `lib/whats-new.ts` (docs/HANDOVER.md
section 8, "What's new"). `npm run check:links` must pass. The reviewer checks all of this.

Agent-facing text (lib/mcp/docs.ts, MCP answers, worker hooks) uses the Words in docs/HANDOVER.md section 3; `npm run check:words` must pass.
