'use client';

import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { SearchButton } from '@/components/search-button';
import { CopyBox } from '@/components/copy-box';
import { cn } from '@/lib/utils';
import { Card, Disclosure, Field, Label, code } from '../settings/ui';

export type ToolRow = { name: string; writes: boolean; description: string; example: string };
export type ToolGroup = { title: string; tools: ToolRow[] };

/**
 * Reference: grouped tool list (the global search finds a tool under Pages and opens it here: #tool-<name>); "what Claude
 * is told" and test commands collapsed.
 */
export function ReferenceTab({ groups, instructions, token, url }: { groups: ToolGroup[]; instructions: string; token?: string; url: string }) {
  const [openName, setOpenName] = useState<string | null>(null);
  useEffect(() => {
    const fromHash = () => {
      const m = /^#tool-([a-z_]+)$/.exec(window.location.hash);
      if (m) setOpenName(m[1]);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);
  const shown = groups.filter(g => g.tools.length > 0);
  const key = token ?? '<your key>';

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <SearchButton kind="pages" label="Search tools" data-tool-search className="w-full justify-start h-11 md:h-9" />
        {shown.map(g => (
          <section key={g.title}>
            <Label>{g.title}</Label>
            <Card grouped>
              {g.tools.map(t => {
                const open = openName === t.name;
                return (
                  <div key={t.name} data-tool={t.name}>
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setOpenName(open ? null : t.name)}
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
