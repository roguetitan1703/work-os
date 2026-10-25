import { CopyBox } from '@/components/copy-box';
import { fmtAgo } from '@/lib/format';
import { urlTokenAllowed } from '@/lib/auth';
import type { AuthorizedApp } from '@/lib/oauth';
import { BRIEF_PROMPT, PROJECT_INSTRUCTIONS } from './data';
import { AuthorizedApps } from './authorized-apps';
import { Card, Disclosure, Field, Section, StatusLine, code } from './ui';
import { ClaudeCodeKeys } from '../claude/keys';

/**
 * Claude chat and Claude Code: status, how to connect (sign in with Work OS, no key to copy), the apps already signed in
 * (revoke), and API keys under Advanced for scripts and the worker. Prompts collapsed.
 */
export function ChatTab({ url, ready, seen, apps }: { url: string; ready: boolean; seen: string | null; apps: AuthorizedApp[] }) {
  const connected = ready && !!seen;
  const urlFallback = urlTokenAllowed();

  return (
    <div className="space-y-5">
      <Section title="Status">
        <Card>
          {!ready ? (
            <StatusLine level="off" title="Not connected yet">
              <p>Add Work OS as a connector on claude.ai below. You sign in and press Allow; there is no key to copy.</p>
            </StatusLine>
          ) : seen ? (
            <StatusLine level="ok" title={`Connected · last used ${fmtAgo(seen)}`}>
              <p suppressHydrationWarning>Everything Claude changes is marked Claude in each task&apos;s history, and recorded as yours.</p>
            </StatusLine>
          ) : (
            <StatusLine level="warn" title="Connected · never used">
              <p>Approved. Try a chat on claude.ai: &quot;What&apos;s on me today in Work OS?&quot;</p>
            </StatusLine>
          )}
        </Card>
      </Section>

      <Section title="Connect Claude">
        <div data-connect-claude className="space-y-3">
          <Field label="Server URL">
            <CopyBox text={url} />
          </Field>
          <Disclosure title="Claude on claude.ai and Claude Desktop" hint="Add as a custom connector, then sign in" open={!connected}>
            <ol className="list-decimal pl-5 space-y-2">
              <li>
                On claude.ai open <b>Settings → Connectors</b>, click <b>Add custom connector</b>, name it <b>Work OS</b> and paste the URL above.
              </li>
              <li>Leave the advanced fields (client ID and secret) empty and add it.</li>
              <li>
                Click <b>Connect</b>. Work OS opens, asks you to sign in if you are not, and shows <b>&quot;Claude wants to access your Work OS&quot;</b>. Check the organization, press <b>Allow</b>.
              </li>
              <li>
                In a chat, open the tools menu and make sure <b>Work OS</b> is on. Try: <i>&quot;What&apos;s on me today in Work OS?&quot;</i>
              </li>
            </ol>
            <p className="text-xs text-muted-foreground">Desktop and the mobile app use the connector you added on claude.ai. Each sign-in is for the organization you are in when you press Allow.</p>
          </Disclosure>
          <Disclosure title="Claude Code" hint="One command, then sign in from Claude Code" open={!connected}>
            <p>Run this in a terminal (Claude Code 2.1 or newer does the sign-in itself for remote servers):</p>
            <CopyBox text={`claude mcp add --scope user --transport http work-os ${url}`} />
            <p>
              Then start Claude Code, type <code className={code}>/mcp</code>, pick <b>work-os</b> and choose <b>Authenticate</b>, or run <code className={code}>claude mcp login work-os</code>. Your browser opens
              Work OS; press <b>Allow</b>. Claude Code works under the stricter limits (300 calls an hour, deletions limited, notices to task owners).
            </p>
          </Disclosure>
        </div>
      </Section>

      <Section title="Signed-in apps">
        <AuthorizedApps initial={apps} />
        <p className="px-1 pt-2 text-xs text-muted-foreground">
          Apps you allowed to act as you in this organization. Revoking one stops it at once. A removed member&apos;s apps and a password reset revoke everything automatically.
        </p>
      </Section>

      <Section title="Advanced">
        <div data-advanced-keys>
          <Disclosure title="Advanced: API keys" hint="Only for scripts, the worker, or clients that cannot sign in">
            <p>
              Signing in (above) is safer and is the normal way. A key is a long password you copy once; anyone who gets it can act as you until you revoke it. Use one only where
              signing in is not possible. Claude Code keys are made in Claude › Setup.
            </p>
            <ClaudeCodeKeys url={url} agent="claude" urlKey={urlFallback} />
            <p className="px-1 text-xs text-muted-foreground">
              Server URL <code className={code}>{url}</code>; header <code className={code}>Authorization: Bearer {'<key>'}</code> (or <code className={code}>X-API-Key</code>). Each key is yours:
              what it changes is recorded as you. Rotate or revoke it here.
            </p>
            <p className="text-xs text-muted-foreground">
              For a client with no header or sign-in option, set <code className={code}>MCP_ALLOW_URL_TOKEN=1</code> on the server and use <code className={code}>{url}/{'<key>'}</code> (the key then lives
              in the URL, so treat the URL as a password). Currently: <b>{urlFallback ? 'enabled' : 'disabled'}</b>.
            </p>
          </Disclosure>
        </div>
      </Section>

      <Section title="Prompts">
        <Disclosure title="Prompts" hint="Project instructions and morning brief" open={!connected}>
          <Field label="Tell Claude how you use it (paste into a Claude Project's instructions, or Settings → Profile → personal preferences)">
            <CopyBox text={PROJECT_INSTRUCTIONS} multiline />
          </Field>
          <Field label="Add to the morning brief (the prompt of your weekday 8am brief, alongside Calendar, Gmail and Vercel)">
            <CopyBox text={BRIEF_PROMPT} multiline />
          </Field>
        </Disclosure>
      </Section>
    </div>
  );
}
