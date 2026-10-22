import Link from '@/components/intent-link';
import { Bot, ChevronDown, ChevronRight, MessageSquare, SquareTerminal } from 'lucide-react';
import { instructions, TOOLS } from '@/lib/mcp/docs';
import { getOrgModes } from '@/lib/org-modes';
import { cn } from '@/lib/utils';
import { baseUrl } from './base-url';
import { ChatTab } from './chat-tab';
import { GROUPS } from './data';
import { DiscordSection } from './discord-section';
import { overviewCards, type Card } from './overview-data';
import { ReferenceTab } from './reference-tab';
import { Disclosure, Dot } from './ui';
import { requireCaller } from '@/lib/caller';

const ICON = { chat: MessageSquare, code: SquareTerminal, discord: Bot, alerts: Bot } as const;

/** One card per integration: status always visible, setup behind the card. Keys and computers live in Claude > Setup. */
export async function Connections({ open }: { open?: string }) {
  const caller = await requireCaller();
  const [base, status, modes] = await Promise.all([baseUrl(), overviewCards(caller), getOrgModes(caller.orgId)]);
  const url = `${base}/api/mcp`;
  const by = (t: Card['tab']) => status.cards.find(c => c.tab === t)!;
  const code = by('code');
  const CodeIcon = ICON.code;
  return (
    <div className="space-y-3" data-connections>
      <ConnectionCard card={by('chat')} id="chat" open={open === 'chat'}>
        <ChatTab url={url} ready={status.mcpReady} seen={status.mcpSeen} />
        <Disclosure title="Tools" hint="What Claude chat and Claude Code can do here">
          <ReferenceTab
            url={url}
            instructions={instructions({ name: caller.name, modes: modes.map(m => m.name) })}
            groups={GROUPS.map(g => ({
              title: g.title,
              tools: g.tools.map(name => ({ name, writes: TOOLS[name].writes, description: TOOLS[name].description, example: TOOLS[name].example })),
            }))}
          />
        </Disclosure>
      </ConnectionCard>

      <Link
        href="/claude?tab=setup"
        data-connection="code"
        className="flex items-center gap-3 px-4 min-h-16 py-3 rounded-2xl bg-card border border-border/70 active:bg-muted/60"
      >
        <CodeIcon className="w-5 h-5 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-medium text-foreground">Claude Code</div>
          <div className="flex items-center gap-2 text-[13px] text-foreground/85">
            <Dot level={code.level} />
            <span className="truncate" suppressHydrationWarning>{code.status}</span>
          </div>
          <div className="text-[12px] text-muted-foreground">Keys and computers are in Claude › Setup</div>
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0" />
      </Link>

      <ConnectionCard card={by('discord')} id="discord" open={open === 'discord'}>
        <DiscordSection base={base} caller={caller} />
      </ConnectionCard>
    </div>
  );
}

function ConnectionCard({ card, id, open, children }: { card: Card; id: string; open: boolean; children: React.ReactNode }) {
  const Icon = ICON[card.tab];
  return (
    <details open={open} data-connection={id} className="group rounded-2xl bg-card border border-border/70 overflow-hidden min-w-0">
      <summary className="flex items-center gap-3 px-4 min-h-16 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden active:bg-muted/60">
        <Icon className="w-5 h-5 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-medium text-foreground">{card.title}</div>
          <div className="flex items-center gap-2 min-w-0 text-[13px] text-foreground/85">
            <Dot level={card.level} />
            <span className="truncate" suppressHydrationWarning>{card.status}</span>
          </div>
          {card.facts.length > 0 && <div className="text-[12px] text-muted-foreground truncate" suppressHydrationWarning>{card.facts.join(' · ')}</div>}
        </div>
        <ChevronDown className={cn('w-4 h-4 text-muted-foreground shrink-0 transition-transform group-open:rotate-180')} />
      </summary>
      <div className="border-t border-border/60 p-4 space-y-4 min-w-0 bg-background/40">{children}</div>
    </details>
  );
}
