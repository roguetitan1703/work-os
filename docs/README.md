# Work OS docs

- `OVERVIEW.md`: start here. What Work OS is for, every feature and workflow in a line, with links.
- `HANDOVER.md`: the reference. One section per feature: how it is built, its files and rules. Section 3 holds the Words, section 8 the UI pieces and What's new.
- `flows/`: only the complex step-by-step paths (`agent-system`, `session-messaging`, `enforcement`, `mail-connect`). Each is linked from its HANDOVER section.
- `ops/`: how-tos for running Work OS (hosting, setting up a PC, the worker launcher, the dispatcher, auth, calendar, cpu, multi-user, Connect, the request log, Akash's takeover).
- `archive/`: records that are never updated (old designs, reviews, audits, the 14 Nov product draft). Each starts with a dated line saying what replaced it.
- `skills/transfer-alias.md`: a skill text to paste, not a doc.

**Upkeep.** A change updates its feature's HANDOVER section when it changes what the section says, and its flow file if it has one, in the same commit. A change to deploy, hosting, setup, the worker or the launcher updates its `ops/` file (`ops/launcher.md` also holds live feature text, Usage and Turbo). A change that adds or removes a feature or workflow also updates its line in OVERVIEW.md. A user-facing change adds a What's new entry (`lib/whats-new.ts`). `npm run check:links` must pass. The reviewer checks this. Nothing in `archive/` is edited.
