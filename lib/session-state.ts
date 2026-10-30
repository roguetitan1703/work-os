import type { SessionView } from '@/lib/data/launcher';

// Honest session labels (docs/launcher.md "Sessions list"): shared by the project page and /claude.

const STATE: Record<SessionView['state'], { label: string; tone: string }> = {
  starting: { label: 'starting', tone: 'text-sky-600 dark:text-sky-400' },
  running: { label: 'open', tone: 'text-green-600 dark:text-green-400' },
  dead: { label: 'closed', tone: 'text-muted-foreground' },
  stopped: { label: 'stopped', tone: 'text-muted-foreground' },
  failed: { label: 'failed', tone: 'text-red-600 dark:text-red-400' },
  unknown: { label: 'no news from its computer', tone: 'text-amber-600 dark:text-amber-400' },
};

export function stateText(s: Pick<SessionView, 'state' | 'linked' | 'waiting' | 'deviceName' | 'cloning' | 'needsTrust'>): { label: string; tone: string } {
  if (s.needsTrust) return { label: `Waiting for you to trust this new repo on ${s.deviceName}`, tone: 'text-amber-600 dark:text-amber-400' };
  if (s.cloning && s.state === 'starting') return { label: `Cloning on ${s.deviceName}…`, tone: STATE.starting.tone };
  if (!s.linked && s.state !== 'running' && s.state !== 'starting' && s.state !== 'failed') return { label: 'ended · folder unlinked', tone: 'text-muted-foreground' };
  if (s.state === 'starting' && s.waiting) return { label: `Waiting: check the terminal on ${s.deviceName}`, tone: 'text-amber-600 dark:text-amber-400' };
  if (s.state === 'running') return { label: `open on ${s.deviceName}`, tone: STATE.running.tone };
  return STATE[s.state];
}

/** What can be done with a session (same rules as the project page). */
export function sessionCan(s: Pick<SessionView, 'state' | 'linked'>) {
  const live = s.state === 'running' || s.state === 'starting';
  const ended = s.state === 'dead' || s.state === 'stopped' || s.state === 'failed';
  return { stop: live || s.state === 'unknown', resume: s.linked && (ended || s.state === 'unknown'), remove: ended || s.state === 'unknown' };
}
