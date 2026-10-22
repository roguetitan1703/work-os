import { CopyBox } from '@/components/copy-box';
import { fmtAgo } from '@/lib/format';
import { urlTokenAllowed } from '@/lib/auth';
import { BRIEF_PROMPT, PROJECT_INSTRUCTIONS } from './data';
import { Card, Disclosure, Field, Section, StatusLine, code } from './ui';
import { ClaudeCodeKeys } from '../claude/keys';

/** Claude chat: status and the two values to paste first; setup guide and prompts collapsed (open only when not connected). */
export function ChatTab({ url, ready, seen }: { url: string; ready: boolean; seen: string | null }) {
  const connected = ready && !!seen;
  const urlFallback = urlTokenAllowed();

  return (
    <div className="space-y-5">
      <Section title="Status">
        <Card>
          {!ready ? (
            <StatusLine level="off" title="Not set up · no key yet">
              <p>Create a Claude chat key below, then add the connector on claude.ai.</p>
            </StatusLine>
          ) : seen ? (
            <StatusLine level="ok" title={`Connected · last used ${fmtAgo(seen)}`}>
              <p suppressHydrationWarning>Everything Claude changes is marked Claude in each task&apos;s history, and recorded as yours.</p>
            </StatusLine>
          ) : (
            <StatusLine level="warn" title="Not set up yet · never used">
              <p>The key is ready. Follow the setup guide below to add the connector on claude.ai.</p>
            </StatusLine>
          )}
        </Card>
      </Section>

      <Section title="Your Claude chat keys">
        <ClaudeCodeKeys url={url} agent="claude" urlKey={urlFallback} />
        <p className="px-1 text-xs text-muted-foreground">
          Server URL <code className={code}>{url}</code>; header <code className={code}>Authorization: Bearer {'<key>'}</code> (or <code className={code}>X-API-Key</code>). Each key
          is yours: what it changes is recorded as you. Rotate or revoke it here.
        </p>
      </Section>

      <Section title="Setup">
        <div className="space-y-3">
          <Disclosure title="Setup guide" hint="Add the connector on claude.ai" open={!connected}>
            <ol className="list-decimal pl-5 space-y-2">
              <li>
                On claude.ai open <b>Settings → Connectors</b> and click <b>Add custom connector</b>. Name it <b>Work OS</b>.
              </li>
              <li>Server URL: the one above. Create a key above first.</li>
              <li>
                Authentication: choose <b>no sign-in</b> (no OAuth). Under <b>Request headers</b> add the header name and value above.
              </li>
              <li>
                In a chat, open the tools menu and make sure <b>Work OS</b> is switched on. Try: <i>&quot;What&apos;s on me today in Work OS?&quot;</i>
              </li>
            </ol>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer min-h-11 flex items-center">My connector dialog has no Request headers field</summary>
              <p className="pb-2">
                Older layouts only offer OAuth. As a stopgap, set <code className={code}>MCP_ALLOW_URL_TOKEN=1</code> on the server and use <code className={code}>{url}/{'<key>'}</code> as
                the URL with a Claude chat key (the key then lives in the URL, so treat the URL as a password). Currently: <b>{urlFallback ? 'enabled' : 'disabled'}</b>.
              </p>
            </details>
          </Disclosure>

          <Disclosure title="Prompts" hint="Project instructions and morning brief" open={!connected}>
            <Field label="Tell Claude how you use it (paste into a Claude Project's instructions, or Settings → Profile → personal preferences)">
              <CopyBox text={PROJECT_INSTRUCTIONS} multiline />
            </Field>
            <Field label="Add to the morning brief (the prompt of your weekday 8am brief, alongside Calendar, Gmail and Vercel)">
              <CopyBox text={BRIEF_PROMPT} multiline />
            </Field>
          </Disclosure>
        </div>
      </Section>
    </div>
  );
}
