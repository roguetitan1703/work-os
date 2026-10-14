import { headers } from 'next/headers';
import { CopyBox } from '@/components/copy-box';
import { INSTRUCTIONS, TOOLS, type ToolName } from '@/lib/mcp/docs';
import { cn } from '@/lib/utils';
import { urlTokenAllowed } from '@/lib/auth';
import { DiscordSection } from './discord-section';
import { AlertsSection } from './alerts-section';
import { ClaudeCodeKeys } from './claude-code-keys';
import { SubHeader } from '@/components/mobile/sub-header';

export const metadata = { title: 'Connect Claude · Work OS' };

async function baseUrl(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

const PROJECT_INSTRUCTIONS = `I track all my work in Work OS (connected as a tool). Treat it as the source of truth for what I'm working on.

- When I mention a task, look it up there (refer to tasks by #number).
- When I say I did, finished, started or got blocked on something, update Work OS: log_progress with a short note, complete_task when it's done, or set Blocked with the reason.
- When I mention new work ("I need to…", "remind me to…", "add…"), add it as a task with a sensible project, priority and due date. Ask only if the project is genuinely unclear.
- Always include a short note on writes so the history explains why.
- Never drop or archive tasks without asking me first.`;

const BRIEF_PROMPT = `Morning brief, Work OS section:
Call the Work OS daily_summary tool once. From it, write:
1. Overdue — each task with how many days late, oldest first.
2. Today — due today plus anything In Progress.
3. Blocked / waiting — with the reason or what it's waiting on.
4. Since yesterday — what got completed and what changed (say when Claude made the change).
5. One line on projects with overdue work.
Keep it short; link each task with its url. If nothing is overdue or due, say so in one line.

Discord section:
Call discord_needs_attention once (default window is since the start of the last workday). List "Flagged for later" first (my bot-tagged notes, with the message I was replying to), then what needs me grouped by channel, unhandled first, each with its jump link. Mention threads I'm in that moved. If it reports warnings (content intent off, channels it can't read, capped), add one line about it.`;

const ORDER: ToolName[] = [
  'daily_summary',
  'list_tasks',
  'get_task',
  'recent_activity',
  'list_projects',
  'add_task',
  'update_task',
  'log_progress',
  'complete_task',
  'add_comment',
  'apply_changes',
  'get_project',
  'delete_task',
  'restore_task',
  'list_trash',
  'write_note',
  'read_note',
  'list_notes',
  'delete_note',
  'update_checklist',
  'add_project',
  'update_project',
  'discord_needs_attention',
  'discord_list_channels',
  'discord_read_messages',
  'discord_message_to_task',
];

export default async function ConnectPage() {
  const base = await baseUrl();
  const token = process.env.MCP_TOKEN;
  const ready = !!token && token.length >= 24;
  const key = token ?? '<MCP_TOKEN>';
  const url = `${base}/api/mcp`;
  const urlFallback = urlTokenAllowed();

  return (
    <div className="max-w-3xl space-y-6 md:space-y-8 min-w-0">
      <SubHeader title="Connect" subtitle="Claude and Discord" />
      <p className="md:hidden text-sm text-muted-foreground -mt-2 px-1">Let Claude on claude.ai read and update your tasks. Everything it changes is marked Claude in the task history.</p>
      <div className="hidden md:block">
        <h1 className="text-2xl font-bold text-foreground">Connect Claude</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Let Claude on claude.ai (chat and the morning brief) read and update your tasks. Everything Claude changes shows up in each task&apos;s history
          marked <span className="px-1 rounded bg-orange-500/15 text-orange-700 dark:text-orange-300 text-xs font-medium">Claude</span>.
        </p>
      </div>

      {!ready && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          <code>MCP_TOKEN</code> is not set (or shorter than 24 characters) on the server, so the connector will refuse every request. Set it in
          Vercel → Settings → Environment Variables and redeploy.
        </div>
      )}

      <Step n={1} title="Add the connector">
        <ol className="list-decimal pl-5 space-y-1 text-sm text-foreground/90">
          <li>
            On claude.ai open <b>Settings → Connectors</b> and click <b>Add custom connector</b>. Name it <b>Work OS</b>.
          </li>
          <li>Server URL:</li>
        </ol>
        <CopyBox text={url} />
        <ol start={3} className="list-decimal pl-5 space-y-1 text-sm text-foreground/90">
          <li>
            Authentication: choose <b>no sign-in</b> (no OAuth). Under <b>Request headers</b> add:
          </li>
        </ol>
        <div className="grid grid-cols-[minmax(0,_auto)_minmax(0,_1fr)] md:grid-cols-[120px_minmax(0,_1fr)] gap-2 items-center text-sm">
          <span className="text-muted-foreground text-xs">Header name</span>
          <CopyBox text="Authorization" />
          <span className="text-muted-foreground text-xs">Header value</span>
          <CopyBox text={`Bearer ${key}`} secret={token} />
        </div>
        <p className="text-xs text-muted-foreground">
          <code>X-API-Key: {'<key>'}</code> works too. The key is <code>MCP_TOKEN</code> in Vercel; to rotate it, change it there, redeploy, and update the header.
        </p>
        <ol start={4} className="list-decimal pl-5 space-y-1 text-sm text-foreground/90">
          <li>
            In a chat, open the tools menu and make sure <b>Work OS</b> is switched on. Try: <i>&quot;What&apos;s on me today in Work OS?&quot;</i>
          </li>
        </ol>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">My connector dialog has no Request headers field</summary>
          <p className="mt-2">
            Older layouts only offer OAuth. As a stopgap, set <code>MCP_ALLOW_URL_TOKEN=1</code> in Vercel and use <code>{url}/{'<key>'}</code> as the URL (the key then
            lives in the URL, so treat the URL as a password). Currently: <b>{urlFallback ? 'enabled' : 'disabled'}</b>.
          </p>
        </details>
      </Step>

      <Step n={2} title="Tell Claude how you use it">
        <p className="text-sm text-muted-foreground">
          Paste into a Claude Project&apos;s instructions (or Settings → Profile → personal preferences) so it keeps Work OS up to date as you talk.
        </p>
        <CopyBox text={PROJECT_INSTRUCTIONS} multiline />
      </Step>

      <Step n={3} title="Add it to the morning brief">
        <p className="text-sm text-muted-foreground">Add this to the prompt of your weekday 8am brief, alongside Calendar, Gmail and Vercel.</p>
        <CopyBox text={BRIEF_PROMPT} multiline />
      </Step>

      <ClaudeCodeKeys url={url} />

      <DiscordSection base={base} />

      <AlertsSection base={base} />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">What Claude can do</h2>
        <div className="rounded-2xl md:rounded-lg border border-border/70 md:border-border divide-y divide-border/60 md:divide-border overflow-hidden bg-card">
          {ORDER.map(name => {
            const t = TOOLS[name];
            return (
              <div key={name} className="px-4 py-3 space-y-1">
                <div className="flex items-center gap-2">
                  <code className="text-xs font-semibold text-foreground">{name}</code>
                  <span
                    className={cn(
                      'text-[10px] px-1.5 py-px rounded font-medium',
                      t.writes ? 'bg-orange-500/15 text-orange-700 dark:text-orange-300' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {t.writes ? 'writes' : 'read-only'}
                  </span>
                </div>
                <p className="text-sm text-foreground/80">{t.description}</p>
                <p className="text-xs text-muted-foreground">Ask: “{t.example}”</p>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">No delete: Claude can set a task to Dropped, but only you can archive.</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">What Claude is told when it connects</h2>
        <CopyBox text={INSTRUCTIONS} multiline />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">Test the endpoint</h2>
        <p className="text-sm text-muted-foreground">From the repo:</p>
        <CopyBox text={`node scripts/test-mcp.mjs ${url} ${key}`} secret={token} />
        <p className="text-sm text-muted-foreground">Or raw, with curl:</p>
        <CopyBox
          text={`curl -s -X POST ${url} -H "Authorization: Bearer ${key}" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"daily_summary","arguments":{}}}'`}
          secret={token}
        />
      </section>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-background text-[11px]">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}
