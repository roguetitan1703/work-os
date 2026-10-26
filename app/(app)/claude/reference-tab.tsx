'use client';

import { useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { CopyBox } from '@/components/copy-box';
import { cn } from '@/lib/utils';
import { Card, Disclosure, Field, Label, code } from '../settings/ui';

export type ToolRow = { name: string; writes: boolean; description: string; example: string };
export type ToolGroup = { title: string; tools: ToolRow[] };

/** Reference: grouped, searchable tool list; "what Claude is told" and test commands collapsed. */
export function ReferenceTab({ groups, instructions, token, url }: { groups: ToolGroup[]; instructions: string; token?: string; url: string }) {
  const [q, setQ] = useState('');
  const [openName, setOpenName] = useState<string | null>(null);
  const needle = q.trim().toLowerCase();
  const shown = groups
    .map(g => ({ ...g, tools: g.tools.filter(t => !needle || `${t.name} ${t.description} ${t.example}`.toLowerCase().includes(needle)) }))
    .filter(g => g.tools.length > 0);
  const key = token ?? '<your key>';

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search tools"
            aria-label="Search tools"
            className="w-full h-11 rounded-xl border border-input bg-background dark:bg-input/30 pl-10 pr-3 text-base md:text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
        {shown.length === 0 && <p className="px-1 text-sm text-muted-foreground">No tool matches &ldquo;{q}&rdquo;.</p>}
        {shown.map(g => (
          <section key={g.title}>
            <Label>{g.title}</Label>
            <Card grouped>
              {g.tools.map(t => {
                const open = openName === t.name || !!needle;
                return (
                  <div key={t.name}>
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setOpenName(open && !needle ? null : t.name)}
                      className="w-full flex items-center gap-2 px-4 min-h-12 text-left active:bg-muted/60"
                    >
                      <code className="text-[13px] font-semibold text-foreground truncate">{t.name}</code>
                      <span
                        className={cn(
                          'text-[10px] px-1.5 py-px rounded font-medium shrink-0',
                          t.writes ? 'bg-orange-500/15 text-orange-700 dark:text-orange-300' : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {t.writes ? 'writes' : 'read-only'}
                      </span>
                      <ChevronDown className={cn('w-4 h-4 ml-auto text-muted-foreground shrink-0 transition-transform', open && 'rotate-180')} />
                    </button>
                    {open && (
                      <div className="px-4 pb-3 space-y-1">
                        <p className="text-sm text-foreground/80">{t.description}</p>
                        <p className="text-xs text-muted-foreground">Ask: “{t.example}”</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </Card>
          </section>
        ))}
        <p className="px-1 text-xs text-muted-foreground">No delete: Claude can set a task to Dropped, but only you can archive.</p>
      </div>

      <div className="space-y-3">
        <Disclosure title="What Claude is told when it connects" hint="The server instructions">
          <CopyBox text={instructions} multiline />
        </Disclosure>
        <Disclosure title="Test the endpoint" hint="Script and curl">
          <Field label="From the repo">
            <CopyBox text={`node scripts/test-mcp.mjs ${url} ${key}`} secret={token} />
          </Field>
          <Field label="Or raw, with curl">
            <CopyBox
              text={`curl -s -X POST ${url} -H "Authorization: Bearer ${key}" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"daily_summary","arguments":{}}}'`}
              secret={token}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            Both use one of your keys (Claude chat or Claude Code).
          </p>
        </Disclosure>
      </div>
    </div>
  );
}
