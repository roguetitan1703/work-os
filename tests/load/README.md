# Load simulation

What a team of 20 costs the server, measured the way the EC2 box runs it (production build, `next start`, heap
capped like `deploy/systemd/work-os.service`). Results and the t3.small projection: docs/cpu.md "Multi-user".
Throwaway mongod and database only; `.env.local` is moved aside for the run and put back.

```
bash tests/load/run.sh                                  # the full day: 8 h in 16 min, then an idle minute
bash tests/load/run.sh --minutes 3 --hours 1 --no-probe # a quick look
SKIP_BUILD=1 LOAD_OUT=<dir> bash tests/load/run.sh ...  # reuse .next; keep report.json, report.txt, server.log
LOAD_SCRIPT=patterns.mjs SKIP_BUILD=1 bash tests/load/run.sh   # what one real tab requests, per step
LOAD_SCRIPT=probe.mjs SKIP_BUILD=1 bash tests/load/run.sh      # cost per request kind only
```

Ports 27285 (mongod), 3285 (app), 4405 (meter); `LOAD_MPORT`, `LOAD_APORT`, `LOAD_METER` change them.

## Pieces

| File | What |
|---|---|
| `run.sh` | mongod, build, seed, server with the meter preloaded, then the script |
| `meter.cjs` | preloaded into the server (`--require`): requests, bytes (as sent, gzipped), time and database calls per route; CPU, memory, event-loop lag, GC, open streams. Tags every Mongo call with its route (`comment`) so the profiler can group by route. `GET /stats`, `POST /reset` on the meter port |
| `measure.mjs` | reads the meter and the mongod profiler (per route: operations, documents examined, collection scans) |
| `seed.mjs` | 20 people (2 admins), 50 projects, 2,000 tasks (about 690 open), 300 notes, 150 Claude items, schedules, a computer and Claude chat key each; 3 people use the dispatcher. Writes `team.json` |
| `clients.mjs` | a scripted browser that sends what a real tab sends (navigation, prefetches, refreshes, actions, the push stream), a worker (the real core and loop on a simulated clock), MCP calls |
| `day.mjs` | the behaviour model: about 15 things an hour per person, an hour's lunch, a third of people keep the Claude page open |
| `sim.mjs` | the day: `--real` real Chromium tabs (page clock sped up), the rest scripted; 20 workers; MCP. Then idle. Writes the report |
| `probe.mjs` | each request kind on its own: operations, documents examined, scans, KB, CPU ms |
| `session.mjs`, `patterns.mjs` | one real tab through a short session; requests per step and kind |
| `idle.mjs` | an hour of an idle page (page clock) and an idle worker (simulated clock) |
| `budgets.json` | ceilings checked by the `budgets` e2e suite (`tests/e2e/budgets.mjs`) |

## Keeping the scripted browser honest

The scripted browser copies the real router: a link in view (or hovered, with `components/intent-link.tsx`) costs
two prefetch requests (`/_tree` and metadata); a write's action response carries the new page and, because every
action revalidates, drops the router's prefetch cache, so visible links prefetch again. After a change to links,
prefetching, actions or push topics, run `patterns.mjs` and compare with `clients.mjs` (`PREFETCH`, `PAGE_LINKS`,
`CLAUDE_TOPICS`). `LOAD_PREFETCH=viewport|intent` and `LOAD_CLAUDE_TOPICS=claude,tasks` replay the old behaviour.

## Budgets

`budgets.json` holds ceilings about 25% above the measured numbers: per request kind (KB, database operations,
documents examined, collection scans), requests per step of the real session, requests per hour of an idle page and
an idle worker, and per user-hour for a minute of the whole team. The `budgets` e2e suite (about 3 minutes) fails
with `budget <where> <metric>: <actual> <= <budget>`. When a change makes something legitimately dearer, re-measure
and raise that one number in the same commit, and say why in the message.
