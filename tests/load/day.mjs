// What one person does in a working day (tests/load/README.md), for sim.mjs and the budgets suite:
//   personDay   the browser: about 15 things an hour (open Today, Tasks, a project, a task, Notes, Claude; complete a
//               task, change one, comment, quick add, now and then give a task to Claude); an hour away at lunch; a
//               third of the people keep the Claude page open between things; the preloader while in use.
//   claudeDay   the person's Claude on the connector: a daily summary first, then about 6 calls an hour.
import { Browser, mcpCall, pageOf } from './clients.mjs';
import { idsFor } from './probe.mjs';

/**
 * ctx: { team, clock (sim ms), speed (sim ms per real ms), t0 (sim start), dayMs, stop: { stop }, rec(tag) -> logger,
 * rnd }. Counts what was done in ctx.done (browser things, MCP calls).
 */
export function makeDay(ctx) {
  const { team, clock, speed, dayMs, stop, rnd } = ctx;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const simWait = simMs => sleep(Math.max(1, simMs / speed));
  const pick = a => a[Math.floor(rnd() * a.length)];
  const expo = mean => -Math.log(1 - rnd()) * mean;
  const done = (ctx.done ??= { things: 0, writes: 0, mcp: 0 });
  const t0 = () => ctx.t0;
  const going = () => !stop.stop && clock() - t0() < dayMs;

  async function personDay(p, idx, cookie, { lunch = true, startWithin = 20 * 60_000 } = {}) {
    const ids = idsFor(team, p);
    const rec = ctx.rec('scripted');
    const b = new Browser({ cookie, clock, ids, rec, rng: rnd });
    const watcher = idx % 3 === 0; // a third keep the Claude page open between things
    const lunchAt = dayMs * (0.45 + rnd() * 0.1);
    let lunched = !lunch;
    await simWait(rnd() * startWithin);
    await b.load('/today');
    if (watcher) await b.nav('/claude');
    let lastInput = clock();
    const give = [...(p.giveTasks ?? [])].slice(0, 2);
    const open = [...ids.openTasks];
    const warmTick = setInterval(() => { if (clock() - lastInput < 10 * 60_000) b.warm().catch(() => {}); }, Math.max(50, 30_000 / speed));
    try {
      while (going()) {
        if (!lunched && clock() - t0() > lunchAt) {
          lunched = true;
          await simWait(60 * 60_000); // an hour away (the tab stays as it was)
        }
        await simWait(expo(4 * 60_000)); // about 15 things an hour
        if (!going()) break;
        lastInput = clock();
        const r = rnd();
        try {
          if (r < 0.2) await b.nav('/today');
          else if (r < 0.35) await b.nav('/tasks');
          else if (r < 0.48) await b.nav(`/projects/${pick(ids.projects)}`);
          else if (r < 0.6) await b.nav(`/tasks/${pick(ids.tasks)}`);
          else if (r < 0.64) await b.nav('/notes');
          else if (r < 0.67) await b.nav('/projects');
          else if (r < 0.7) await b.nav('/claude');
          else {
            done.writes++;
            if (r < 0.79) {
              // complete a task from Today (desktop row: the action only)
              if (pageOf(b.path) !== 'today') await b.nav('/today');
              const id = open.shift();
              if (id) await b.action('completeTaskAction', [id]);
            } else if (r < 0.9) {
              // change priority or due on the Tasks list (inline selects: the action only)
              if (pageOf(b.path) !== 'tasks') await b.nav('/tasks');
              const task = team.tasks.find(x => x.ref === pick(ids.refs));
              await b.action('updateTaskAction', [task.id, rnd() < 0.5 ? { priority: pick(['P1', 'P2', 'P3']) } : { due: null }]);
            } else if (r < 0.96) {
              // a comment on a task page (comment entry: the action, then router.refresh())
              const ref = pick(ids.refs);
              await b.nav(`/tasks/${ref}`);
              const task = team.tasks.find(x => x.ref === ref);
              await b.action('addCommentAction', [task.id, 'Looked at it with the client today.'], { thenRefresh: true });
            } else if (r < 0.985 || !give.length) {
              // quick add (N): the action only
              await b.action('createTaskAction', [{ title: `Load sim task ${idx}-${Math.floor(rnd() * 1e6)}`, projectId: pick(ids.projects), priority: 'P3' }]);
            } else {
              // give a task to Claude (dispatcher), from the task page
              const ref = give.shift();
              await b.nav(`/tasks/${ref}`);
              await b.action('giveToClaudeAction', [String(ref)], { file: 'app/(app)/claude/dispatcher-actions.ts' });
            }
          }
          done.things++;
          if (watcher && pageOf(b.path) !== 'claude' && rnd() < 0.7) await b.nav('/claude');
        } catch (e) {
          rec('error', String(e.message).slice(0, 40), -1, 0);
        }
      }
    } finally {
      clearInterval(warmTick);
    }
    return b;
  }

  async function claudeDay(p, { startWithin = 30 * 60_000 } = {}) {
    const ids = idsFor(team, p);
    const rec = ctx.rec('mcp');
    await simWait(rnd() * startWithin);
    await mcpCall(p.claudeKey, 'daily_summary', {}, rec);
    done.mcp++;
    while (going()) {
      await simWait(expo(10 * 60_000));
      if (!going()) break;
      const r = rnd();
      const ref = pick(ids.refs);
      if (r < 0.3) await mcpCall(p.claudeKey, 'list_tasks', { limit: 20 }, rec);
      else if (r < 0.55) await mcpCall(p.claudeKey, 'get_task', { task: ref }, rec);
      else if (r < 0.7) await mcpCall(p.claudeKey, 'add_comment', { task: ref, note: 'Claude: checked the latest state.' }, rec);
      else if (r < 0.8) await mcpCall(p.claudeKey, 'log_progress', { task: ref, progress: pick([20, 40, 60, 80]), note: 'Claude: progress from the session.' }, rec);
      else if (r < 0.9) await mcpCall(p.claudeKey, 'get_project', { project: pick(ids.projects), depth: 'tasks' }, rec);
      else await mcpCall(p.claudeKey, 'list_tasks', { status: 'In Progress' }, rec);
      done.mcp++;
    }
  }

  return { personDay, claudeDay, done };
}
