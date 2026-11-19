import 'server-only';
import { orgWide, scoped, type Scope } from './scope';
import { addDays, startOfDay } from './dates';
import type { DigestSection } from './alerts';
import { neutralAlertText } from './data/dispatcher';
import { listActivity } from './data/tasks';
import { shortAsk } from './data/needs';

// The owner's Monday block (docs/flows/agent-system.md sections 10 and 12; H12 plan note 7f5824bbed): four numbers that say
// whether the Harness is used, and at most three proposals. Numbers are org-wide counts and name nothing; proposals come only
// through the reader's own door (their Needs, the feed they can read). Silence means keep: nothing here writes anything.

/** Om's repeats: counted only once something files a correction a person gave twice (NeedDoc.repeat). Until then the line says so. */
export const REPEATS_COUNTED = false;
/** The target for the first number: sessions that changed files and saved the State, out of those that changed files. */
export const SAVE_TARGET = '9 of 10';
const MAX_PROPOSALS = 3;
const MONDAY_NEED_DAYS = 14;
const MS_DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

/** The tool of a refusal line ("end_work: ..." or "end_work ..."): its first word, else nothing. */
const toolOfRefusal = (r: string): string | undefined => r.trim().match(/^([a-z][a-z0-9_]{1,40})\b/i)?.[1];

/**
 * The Monday numbers and proposals for the week before `today` (the 7 days before today's start in the reader's timezone).
 * Returns the two sections to append to the digest; the caller decides that it is a Monday and the reader an owner.
 */
export async function mondayBlock(s: Scope, x: { today: string; tz: string; now?: Date }): Promise<DigestSection[]> {
  const to = startOfDay(x.today, x.tz);
  const from = startOfDay(addDays(x.today, -7), x.tz);
  const org = await orgWide(s.orgId);
  const week = { $gte: from, $lt: to };

  // 1. Sessions that changed files: how many saved the State, and how many of those only after the reminder.
  const sessions = await org.presence.find({ 'stopCheck.at': week }, { projection: { stopCheck: 1 } }).toArray();
  const saved = sessions.filter(r => r.stopCheck?.files === 'saved');
  const afterReminder = saved.filter(r => r.stopCheck?.reminded).length;

  // 2. PCs: signed-in computers seen this week; no hooks (none, or no events installed) and out of date.
  const pcs = await org.devices.find({ revokedAt: null, lastSeenAt: week }, { projection: { worker: 1 } }).toArray();
  const noHooks = pcs.filter(d => !d.worker?.hooks || !d.worker.hooks.version || !d.worker.hooks.events).length;
  const stale = pcs.filter(d => d.worker?.hooks?.stale).length;

  // 3. WORK-STATE.md hand edits: refused and forwarded, only the days of this week (a session that lives for weeks is not recounted),
  // summed over the sessions seen since the week began. Days are UTC dates.
  const dayFrom = from.toISOString().slice(0, 10);
  const dayTo = to.toISOString().slice(0, 10);
  const edits = await org.presence.find({ lastSeen: { $gte: from }, 'copyEdits.days': { $exists: true } }, { projection: { copyEdits: 1 } }).toArray();
  let refused = 0;
  let forwarded = 0;
  for (const r of edits) {
    for (const [day, n] of Object.entries(r.copyEdits?.days ?? {})) {
      if (day < dayFrom || day >= dayTo) continue;
      refused += n.refused ?? 0;
      forwarded += n.forwarded ?? 0;
    }
  }

  // 4. Om's repeats.
  const repeats = REPEATS_COUNTED ? await org.needs.countDocuments({ repeat: true, createdAt: week }) : null;

  const numbers: DigestSection = {
    head: `📏 **Monday numbers** (${dm(addDays(x.today, -7))}-${dm(addDays(x.today, -1))})`,
    rows: [
      { text: sessions.length ? `Sessions that changed files and saved State: ${saved.length} of ${sessions.length}${afterReminder ? ` (${afterReminder} after the reminder)` : ''}` : 'Sessions that changed files and saved State: none counted yet', detail: `target ${SAVE_TARGET}` },
      { text: pcs.length ? `PCs with no hooks: ${noHooks} of ${pcs.length}${stale ? ` (${stale} out of date)` : ''}` : 'PCs with no hooks: no PC seen this week' },
      { text: `WORK-STATE.md edits: ${refused} refused, ${forwarded} forwarded` },
      { text: repeats === null ? "Om's repeats: not counted yet" : `Om's repeats: ${repeats}` },
    ],
  };

  // Proposals: open Monday Needs of the last 14 days (oldest first), then friction groups by size; at most three lines.
  const c = await scoped(s);
  const monday = await c.needs
    .find({ to: s.userId, status: 'open', batch: 'monday', createdAt: { $gt: new Date(to.getTime() - MONDAY_NEED_DAYS * MS_DAY) } })
    .sort({ createdAt: 1 })
    .limit(20)
    .toArray();
  const lines: DigestSection['rows'] = monday.map(n => ({ label: `Need #${n.ref}`, url: `/today#need-${n.ref}`, text: neutralAlertText(shortAsk(n.ask)), detail: 'Needs' }));

  const feed = await listActivity(s, { since: from, until: to, types: ['feedback', 'session_ended'], limit: 500 });
  const groups = new Map<string, { kind: 'tool' | 'rule'; name: string; lines: number; sessions: Set<string> }>();
  for (const a of feed) {
    if (a.type === 'session_ended' && /^none\b/i.test(a.note ?? '')) continue;
    const f = a.feedback;
    const tool = f?.tool ?? (f?.rule ? undefined : toolOfRefusal(f?.refusals?.[0] ?? ''));
    const name = tool ?? f?.rule;
    if (!name) continue;
    const kind = tool ? 'tool' : 'rule';
    const key = `${kind}:${name}`;
    const g = groups.get(key) ?? { kind, name, lines: 0, sessions: new Set<string>() };
    g.lines++;
    g.sessions.add(a.session ?? `a:${a.id}`);
    groups.set(key, g);
  }
  const friction = [...groups.values()].filter(g => g.lines >= 3 || g.sessions.size >= 2).sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
  for (const g of friction) {
    const name = neutralAlertText(g.name).slice(0, 80);
    lines.push({ text: `Friction: ${g.kind === 'rule' ? `rule "${name}"` : name}, ${g.lines} line${g.lines === 1 ? '' : 's'} from ${g.sessions.size} session${g.sessions.size === 1 ? '' : 's'} this week`, detail: 'Activity' });
  }

  const sections = [numbers];
  if (lines.length) {
    const shown = lines.slice(0, MAX_PROPOSALS);
    if (lines.length > shown.length) shown.push({ label: `+${lines.length - shown.length} more`, url: '/needs', text: 'in the app' });
    sections.push({ head: '💡 **Proposals** (silence means keep)', numbered: true, rows: shown });
  }
  return sections;
}
