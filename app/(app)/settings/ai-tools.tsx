import { CopyBox } from '@/components/copy-box';
import { cn } from '@/lib/utils';
import { CHECKED, tools } from '@/lib/connect-tools';
import { baseUrl } from './base-url';
import { Dot } from './ui';

/** Settings › AI tools: how to connect Claude Code, Cursor, Antigravity and ChatGPT to this server's MCP address (docs/connect.md). */
export async function AiTools() {
  const mcpUrl = `${await baseUrl()}/api/mcp`;
  return (
    <div className="space-y-5" data-ai-tools>
      <div className="space-y-2">
        <p className="text-[15px] md:text-sm text-muted-foreground">
          Any tool that speaks MCP can read and update your tasks here. This server&apos;s address is:
        </p>
        <CopyBox text={mcpUrl} className="[&_pre]:text-[13px]" />
        <p className="text-[13px] text-muted-foreground" data-ai-address={mcpUrl}>
          Snippets were copied from each tool&apos;s own documentation on {CHECKED}. A tool marked &ldquo;not tested yet&rdquo; was never connected to Work OS by us.
        </p>
      </div>
      {tools(mcpUrl).map(t => (
        <section key={t.id} data-ai-tool={t.id} className="rounded-2xl bg-card border border-border/70 p-4 space-y-3 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-foreground">{t.name}</h2>
            <span data-ai-tested={t.tested.done ? 'yes' : 'no'} className={cn('inline-flex items-center gap-1.5 text-[13px] font-medium', t.tested.done ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300')}>
              <Dot level={t.tested.done ? 'ok' : 'warn'} className="w-2 h-2" /> {t.tested.done ? 'Tested' : 'Not tested yet'}
            </span>
          </div>
          <p className="text-[13px] text-muted-foreground leading-snug">{t.tested.note}</p>
          {t.warning && (
            <p data-ai-warning className="text-[14px] md:text-[13px] rounded-lg bg-amber-500/10 text-amber-800 dark:text-amber-300 px-3 py-2">
              {t.warning}
            </p>
          )}
          <p className="text-[15px] md:text-sm text-foreground">{t.signIn}</p>
          <ol className="list-decimal pl-5 space-y-1 text-[15px] md:text-sm text-foreground">
            {t.steps.map(s => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {t.snippets.map(s => (
            <div key={s.label} className="space-y-1 min-w-0">
              <div className="text-[13px] text-muted-foreground">
                {s.label} <span className="text-muted-foreground/70">· {s.where}</span>
              </div>
              <CopyBox text={s.text} multiline />
            </div>
          ))}
          <a href={t.docs.href} target="_blank" rel="noreferrer" className="inline-flex items-center min-h-11 md:min-h-0 text-[14px] md:text-[13px] underline text-muted-foreground hover:text-foreground">
            {t.docs.label}
          </a>
        </section>
      ))}
    </div>
  );
}
