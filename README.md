# Work OS

Personal task manager. Localhost only. No auth, no cloud.

## Setup

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Data

Tasks are stored in `data/tasks.json` (created automatically on first run). This file is gitignored — your data stays local.

## Usage

- **Today** — see today's schedule and all P1 tasks
- **Modes** — 8 work modes, each with its own task list
- **Paste Import** — paste a markdown table from Claude to bulk-insert tasks
- **Hidden Work** — tasks not touched in 7+ days
- **Archive** — completed tasks grouped by week
- **Weekly Review** — log shipped/slipped/adjustments each week
- **Timetable** — full Mon–Fri schedule grid
- **Recovery** — playbook for when the day breaks
