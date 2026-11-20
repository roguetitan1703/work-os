---
name: transfer
description: Transfer (hand over) this session's work to a fresh session through Work OS, like compaction but into a Work OS handover, or pick up a handover with "/transfer pick up <note id>". Use when your person says transfer, hand over, handover, "move this to a new session", or when usage or context is running out.
---

Installed by the Work OS worker (it replaces this folder when a newer version ships; delete the `.work-os-managed` file to keep your own copy).

## Hand over

1. Commit work in progress on your own branch (never `git stash`), so the next session finds it in git.
2. Make the State: the State is always saved first. If the project has no State yet, put `set_now` (with `base_version`) among end_work's `state` ops; otherwise record what changed (if nothing did, `set_where`).
3. Call Work OS `end_work` for this project with a `handover` (its description says what goes in: where things stand, the branch, the next step, what to check first) and one line of `friction`.
4. Give your person the line end_work's answer gives (it names the handover note id), so they can paste it into the new session.
5. Parked lines and decisions stay in Work OS; the handover never copies them.

## Pick up ("pick up <note id>")

1. Call `start_work` for this project with `pick_up: <note id>`. Never read the handover with `read_note` instead: only start_work moves the old session's Needs, messages and held lines to you.
2. Its answer shows the handover and what moved. Check git on the branches it names (status, last commits), then continue from its next step.
