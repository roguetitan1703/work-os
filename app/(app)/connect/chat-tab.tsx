import { CopyBox } from '@/components/copy-box';
import { fmtAgo } from '@/lib/format';
import { urlTokenAllowed } from '@/lib/auth';
import { BRIEF_PROMPT, PROJECT_INSTRUCTIONS } from './data';
import { Card, Disclosure, Field, Section, StatusLine, code } from './ui';

/** Claude chat: status and the two values to paste first; setup guide and prompts collapsed (open only when not connected). */
export function ChatTab({ url, ready, seen }: { url: string; ready: boolean; seen: string | null }) {
  const token = process.env.MCP_TOKEN;
  const key = token ?? '<MCP_TOKEN>';
  const connected = ready && !!seen;
  const urlFallback = urlTokenAllowed();

  return (
    <div className="space-y-5">
      <Section title="Status">
        <Card>
          {!ready ? (
            <StatusLine level="error" title="Problem: MCP_TOKEN is not set">
              <p>
                Not set (or shorter than 24 characters) on the server, so the connector refuses every request. Set it in Vercel → Settings → Environment Variables and redeploy.
              </p>
            </StatusLine>
          ) : seen ? (
            <StatusLine level="ok" title={`Connected · last used ${fmtAgo(seen)}`}>
              <p suppressHydrationWarning>Everything Claude changes is marked Claude in each task&apos;s history.</p>
            </StatusLine>
          ) : (
            <StatusLine level="warn" title="Not set up yet · never used">
              <p>The key is ready. Follow the setup guide below to add the connector on claude.ai.</p>
            </StatusLine>
          )}
        </Card>
      </Section>

      <Section title="Connector details">
        <Card className="p-4 space-y-3">
          <Field label="Server URL">
            <CopyBox text={url} />
          </Field>
          <Field label="Header name">
            <CopyBox text="Authorization" />
          </Field>
          <Field label="Header value">
            <CopyBox text={`Bearer ${key}`} secret={token} />
          </Field>
          <p className="text-xs text-muted-foreground">
            <b>Rotating the key:</b> the key is <code className={code}>MCP_TOKEN</code> in Vercel. Change it there, redeploy, then update the header value in the claude.ai connector.{' '}
            <code className={code}>X-API-Key: {'<key>'}</code> works too.
          </p>
        </Card>
      </Section>

      <Section title="Setup">
        <div className="space-y-3">
          <Disclosure title="Setup guide" hint="Add the connector on claude.ai" open={!connected}>
            <ol className="list-decimal pl-5 space-y-2">
              <li>
                On claude.ai open <b>Settings → Connectors</b> and click <b>Add custom connector</b>. Name it <b>Work OS</b>.
              </li>
              <li>Server URL: the one above.</li>
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
                Older layouts only offer OAuth. As a stopgap, set <code className={code}>MCP_ALLOW_URL_TOKEN=1</code> in Vercel and use <code className={code}>{url}/{'<key>'}</code> as
                the URL (the key then lives in the URL, so treat the URL as a password). Currently: <b>{urlFallback ? 'enabled' : 'disabled'}</b>.
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
