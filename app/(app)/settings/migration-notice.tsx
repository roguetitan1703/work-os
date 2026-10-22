import Link from 'next/link';
import { getCaller } from '@/lib/caller';
import { collections } from '@/lib/db';
import { DismissNotice } from './dismiss-notice';

/**
 * Once, after scripts/migrate-auth.mjs: the Claude Code keys and computers from before sign-in by user could not be
 * moved (only their hashes were stored), so they stopped working. Shown to owners and admins until dismissed.
 */
export async function MigrationNotice() {
  const caller = await getCaller();
  if (!caller || (caller.role !== 'owner' && caller.role !== 'admin')) return null;
  // The notice belongs to the organization the old keys were Om's in (scripts/migrate-ownership.mjs stamps orgId).
  const doc = await (await collections()).settings.findOne({ _id: 'authMigration', orgId: caller.orgId }).catch(() => null); // scope-ok: one-off migration notice, filtered by the caller's organization
  if (!doc || doc.dismissedAt) return null;
  const keys = doc.oldKeys ?? [];
  const devices = doc.oldDevices ?? [];
  if (!keys.length && !devices.length) return null;
  return (
    <div role="status" data-migration-notice className="mt-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-2 text-[14px] text-foreground">
      <p className="font-semibold">Re-create your keys and re-link the worker</p>
      <p className="text-[13px] text-muted-foreground">
        Sign-in now works per person, and keys belong to whoever made them. The old ones stopped working:
        {keys.length > 0 && ` Claude Code keys ${keys.map(k => `"${k.name}"`).join(', ')};`}
        {devices.length > 0 && ` computers ${devices.map(d => `"${d.name}"`).join(', ')};`} and the old MCP_TOKEN for Claude chat.
      </p>
      <ul className="list-disc pl-5 text-[13px]">
        <li>
          Claude chat: <Link className="underline" href="/settings?section=connections&open=chat">create a Claude chat key</Link> and update the claude.ai connector.
        </li>
        <li>
          Claude Code and computers: <Link className="underline" href="/claude?tab=setup">create new keys and add each computer again</Link>, then put the new device key in the
          worker&apos;s config.
        </li>
      </ul>
      <DismissNotice />
    </div>
  );
}
