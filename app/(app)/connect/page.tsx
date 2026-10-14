import { INSTRUCTIONS, TOOLS } from '@/lib/mcp/docs';
import { SubHeader } from '@/components/mobile/sub-header';
import { DiscordSection } from './discord-section';
import { AlertsSection } from './alerts-section';
import { ChatTab } from './chat-tab';
import { CodeTab } from './code-tab';
import { Overview } from './overview';
import { ReferenceTab } from './reference-tab';
import { TabNav } from './tab-nav';
import { GROUPS, tabFrom } from './data';
import { baseUrl } from './base-url';
import { overviewCards } from './overview-data';
import { Section } from './ui';

export const metadata = { title: 'Connect Claude · Work OS' };

type Props = { searchParams: Promise<{ tab?: string }> };

export default async function ConnectPage({ searchParams }: Props) {
  const tab = tabFrom((await searchParams).tab);
  const base = await baseUrl();
  const url = `${base}/api/mcp`;
  const token = process.env.MCP_TOKEN;
  const needsStatus = tab === 'overview' || tab === 'chat';
  const status = needsStatus ? await overviewCards() : null;

  return (
    <div className="max-w-3xl space-y-4 md:space-y-5 min-w-0">
      <SubHeader title="Connect" subtitle="Claude, Discord and alerts" />
      <div className="hidden md:block">
        <h1 className="text-2xl font-bold text-foreground">Connect</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Let Claude (chat and Claude Code) read and update your tasks, plus the Discord bot and alerts. Everything Claude changes shows up in each task&apos;s history marked{' '}
          <span className="px-1 rounded bg-orange-500/15 text-orange-700 dark:text-orange-300 text-xs font-medium">Claude</span>.
        </p>
      </div>

      <TabNav active={tab} />

      {tab === 'overview' && status && (
        <Section>
          <Overview cards={status.cards} />
        </Section>
      )}
      {tab === 'chat' && status && <ChatTab url={url} ready={status.mcpReady} seen={status.mcpSeen} />}
      {tab === 'code' && <CodeTab url={url} />}
      {tab === 'discord' && <DiscordSection base={base} />}
      {tab === 'alerts' && <AlertsSection base={base} />}
      {tab === 'reference' && (
        <ReferenceTab
          url={url}
          token={token}
          instructions={INSTRUCTIONS}
          groups={GROUPS.map(g => ({
            title: g.title,
            tools: g.tools.map(name => ({ name, writes: TOOLS[name].writes, description: TOOLS[name].description, example: TOOLS[name].example })),
          }))}
        />
      )}
    </div>
  );
}
