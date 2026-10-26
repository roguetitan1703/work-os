import { ExternalLink } from 'lucide-react';
import { CopyBox } from '@/components/copy-box';
import { fmtAgo } from '@/lib/format';
import type { AuthorizedApp } from '@/lib/oauth';
import { AuthorizedApps } from './authorized-apps';
import { Disclosure, Field, code } from '../settings/ui';

const cta = 'inline-flex items-center justify-center gap-1.5 h-11 md:h-9 px-4 rounded-lg text-sm font-medium bg-foreground text-background hover:bg-foreground/90 outline-none focus-visible:ring-2 focus-visible:ring-ring/60';

/**
 * Step 1 of Claude › Set up: sign in with Claude (OAuth, no key to copy). Add Work OS as a connector on claude.ai (or
 * one command in Claude Code), press Allow once. Done when an approved app or a key has been used at least once.
 * Details and rules: docs/auth.md "Connecting Claude with OAuth".
 */
export function ConnectStep({ url, done, lastUsedAt, apps }: { url: string; done: boolean; lastUsedAt: string | null; apps: AuthorizedApp[] }) {
  return (
    <div className="space-y-4" data-connect-claude>
      {done ? (
        <p className="text-[15px] text-foreground" suppressHydrationWarning data-connected>
          Connected{lastUsedAt ? `, last used ${fmtAgo(lastUsedAt)}` : ''}. Everything Claude changes is marked Claude in each task&apos;s history, and recorded as yours.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener noreferrer" className={cta} data-sign-in-claude>
              Sign in with Claude <ExternalLink size={14} aria-hidden />
            </a>
          </div>
          <p className="text-[13px] text-muted-foreground">
            After you sign in, ask Claude: &ldquo;What is on my plate today in Work OS?&rdquo; Work OS asks you to sign in and press Allow; there is no key to copy.
          </p>
        </>
      )}
      <Field label="Server address (paste it when Claude asks for the connector URL)">
        <CopyBox text={url} />
      </Field>
      <Disclosure title="Claude on claude.ai and Claude Desktop" hint="Add as a custom connector, then sign in" open={!done}>
        <ol className="list-decimal pl-5 space-y-2">
          <li>
            On claude.ai open <b>Settings → Connectors</b>, click <b>Add custom connector</b>, name it <b>Work OS</b> and paste the address above.
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
      <Disclosure title="Claude Code" hint="One command, then sign in from Claude Code" open={!done}>
        <p>Run this in a terminal (Claude Code 2.1 or newer does the sign-in itself for remote servers):</p>
        <CopyBox text={`claude mcp add --scope user --transport http work-os ${url}`} />
        <p>
          Then start Claude Code, type <code className={code}>/mcp</code>, pick <b>work-os</b> and choose <b>Authenticate</b>, or run <code className={code}>claude mcp login work-os</code>. Your browser opens
          Work OS; press <b>Allow</b>. Claude Code works under the stricter limits (300 calls an hour, deletions limited, notices to task owners).
        </p>
      </Disclosure>
      <div className="space-y-2">
        <h3 className="px-1 text-[13px] font-medium text-muted-foreground">Signed-in apps</h3>
        <AuthorizedApps initial={apps} />
        <p className="px-1 text-xs text-muted-foreground">
          Apps you allowed to act as you in this organization. Revoking one stops it at once. A removed member&apos;s apps and a password reset revoke everything automatically.
        </p>
      </div>
    </div>
  );
}
