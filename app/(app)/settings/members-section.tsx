'use client';

import { useState, useTransition } from 'react';
import { Check, Copy, Mail, UserMinus, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import type { InviteRow, MemberRow } from '@/lib/members';
import { cancelInvitationAction, changeRoleAction, inviteMemberAction, removeMemberAction } from './members-actions';
import { Select } from '@/components/ui/select';

const field =
  'w-full min-w-0 h-11 rounded-xl border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const btn = 'h-11 px-4 rounded-full text-sm font-semibold shrink-0 disabled:opacity-50 inline-flex items-center justify-center gap-1.5';
const iconBtn = 'w-11 h-11 rounded-full flex items-center justify-center text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0 disabled:opacity-50';
const roleSel = 'h-11 rounded-xl border border-input bg-background dark:bg-input/30 px-2 text-base md:text-sm text-foreground outline-none shrink-0 disabled:opacity-50';
/** What each role means, shown under the invite form (the server's rules are in lib/members.ts). */
const ROLE_HINT: Record<string, string> = {
  member: 'Member: works on projects and tasks. Sees shared projects and their own private ones.',
  admin: 'Admin: a member who can also invite people, change roles and remove members.',
  owner: 'Owner: full control of the organization. There is always at least one.',
};
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/**
 * Settings › Members (docs/multi-user.md phase 4): who is in the organization. Owners and admins invite by email, see and
 * cancel pending invitations, change roles and remove members. Only an owner makes, changes or removes an owner; the
 * server checks every rule again (lib/members.ts).
 */
export function MembersSection({ members, invitations, canInvite, isOwner, linkToInviter }: { members: MemberRow[]; invitations: InviteRow[]; canInvite: boolean; isOwner: boolean; linkToInviter: boolean }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [link, setLink] = useState<{ email: string; link: string | null; mailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    const to = email.trim();
    start(async () => {
      const r = await inviteMemberAction(to, role);
      if (!r.ok) return void toast.error(r.error);
      setLink({ email: to, ...r.data });
      setEmail('');
      toast.success(r.data.mailed ? `Invitation sent to ${to}` : 'Invitation made. Email is off: send the link yourself.');
    });
  };

  const cancel = (i: InviteRow) =>
    start(async () => {
      const r = await cancelInvitationAction(i.id);
      if (!r.ok) return void toast.error(r.error);
      toast(`Invitation for ${i.email} cancelled`);
    });

  const setMemberRole = (m: MemberRow, next: string) =>
    start(async () => {
      const r = await changeRoleAction(m.userId, next);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${m.name || m.email} is now ${next === 'admin' ? 'an admin' : `a ${next}`}`);
    });

  const remove = (m: MemberRow) =>
    start(async () => {
      const r = await removeMemberAction(m.userId);
      setRemoving(null);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${m.name || m.email} removed. Their sessions, keys and computers here no longer work.`);
    });

  // Mirrors lib/members.ts: owners manage anyone, admins everyone but owners. Your own row: an owner may step down
  // (refused while they are the only owner); nobody removes themselves.
  const manages = (m: MemberRow) => canInvite && !m.you && (isOwner || m.role !== 'owner');
  const canSetRole = (m: MemberRow) => manages(m) || (m.you && isOwner);

  return (
    <div className="space-y-5" data-members>
      <section>
        <h2 className="px-1 mb-1.5 text-[13px] font-medium text-muted-foreground">People</h2>
        <div className="rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">
          {members.map(m => (
            <div key={m.userId} className="px-4 py-2 min-h-14" data-member={m.email}>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] text-foreground truncate">
                    {m.name || m.email}
                    {m.you && <span className="text-muted-foreground"> (you)</span>}
                  </div>
                  <div className="text-[13px] text-muted-foreground truncate">{m.email}</div>
                </div>
                {canSetRole(m) ? (
                  <>
                    <Select className={roleSel} value={m.role} disabled={pending} onChange={e => setMemberRole(m, e.target.value)} aria-label={`Role of ${m.email}`} data-role-select={m.email}>
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                      {isOwner && <option value="owner">Owner</option>}
                    </Select>
                    {manages(m) && (
                      <button type="button" className={iconBtn} onClick={() => setRemoving(r => (r === m.userId ? null : m.userId))} disabled={pending} aria-label={`Remove ${m.email}`}>
                        <UserMinus className="w-4 h-4" />
                      </button>
                    )}
                  </>
                ) : (
                  <span className="text-[13px] text-muted-foreground capitalize shrink-0">{m.role}</span>
                )}
              </div>
              {removing === m.userId && (
                <div className="mt-2 mb-1 rounded-xl border border-red-500/30 bg-red-500/5 p-3 space-y-2" data-remove-confirm={m.email}>
                  <p className="text-[13px] text-foreground">
                    Remove {m.name || m.email}? They are signed out of this organization, and their Claude keys and computers here stop working. Tasks they gave to Claude stop; tasks assigned to them go back to their owners. Their private tasks and notes are kept, unseen by anyone.
                  </p>
                  <div className="flex gap-2 justify-end">
                    <button type="button" className={`${btn} border border-border`} onClick={() => setRemoving(null)} disabled={pending}>
                      Cancel
                    </button>
                    <button type="button" className={`${btn} bg-red-600 text-white`} onClick={() => remove(m)} disabled={pending}>
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {canInvite && (
        <section id="invite" className="scroll-mt-6">
          <h2 className="px-1 mb-1.5 text-[13px] font-medium text-muted-foreground">Invite</h2>
          <div className="rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">
            {invitations.map(i => (
              <div key={i.id} className="flex items-center gap-3 pl-4 pr-2 py-2 min-h-14" data-invitation={i.email}>
                <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] text-foreground truncate">{i.email}</div>
                  <div className="text-[13px] text-muted-foreground" suppressHydrationWarning>
                    {i.role} · waiting · link works until {day(i.expiresAt)}
                  </div>
                </div>
                <button type="button" className={iconBtn} onClick={() => cancel(i)} disabled={pending} aria-label={`Cancel invitation for ${i.email}`}>
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
            <form onSubmit={invite} className="flex flex-wrap items-center gap-2 px-4 py-3">
              <input className={`${field} flex-1 basis-48`} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address" aria-label="Email to invite" required />
              <Select className={`${field} w-auto`} value={role} onChange={e => setRole(e.target.value)} aria-label="Role" data-invite-role>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                {isOwner && <option value="owner">Owner</option>}
              </Select>
              <button type="submit" className={`${btn} bg-foreground text-background`} disabled={pending}>
                <UserPlus className="w-4 h-4" /> Invite
              </button>
            </form>
          </div>
          <p className="px-1 mt-1.5 text-[13px] text-muted-foreground" data-role-hint={role}>
            {ROLE_HINT[role]}
          </p>
          {link && (
            <div className="mt-3 rounded-xl border border-border/70 p-3 space-y-2" data-invite-link>
              <p className="text-[13px] text-foreground">
                {link.link
                  ? `${link.mailed ? `Sent to ${link.email}. ` : `Email is not set up: send this link to ${link.email} yourself. `}The link works once, for 7 days.`
                  : `Sent to ${link.email}. The link works once, for 7 days; only they have it.`}
              </p>
              {link.link && (
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 break-all rounded-lg bg-muted px-3 py-2 text-[12px] font-mono">{link.link}</code>
                  <button
                    type="button"
                    className={iconBtn}
                    aria-label="Copy link"
                    onClick={() =>
                      navigator.clipboard?.writeText(link.link!).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      })
                    }
                  >
                    {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              )}
            </div>
          )}
          <p className="px-1 mt-1.5 text-xs text-muted-foreground">
            Everyone in the organization sees its shared projects. Admins invite, change roles and remove members; only an owner can make, change or remove an owner. There is always at least one owner.
            {!linkToInviter && ' Invitation links go only by email.'}
          </p>
        </section>
      )}
    </div>
  );
}
