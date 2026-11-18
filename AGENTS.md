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

A user-facing feature adds one What's new entry to `lib/whats-new.ts` in the same change (docs/HANDOVER.md section 8,
"What's new").
