'use client';

import { useState, useTransition } from 'react';
import { Check, Copy, Mail, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import type { InviteRow, MemberRow } from '@/lib/members';
import { cancelInvitationAction, inviteMemberAction } from './members-actions';

const field =
  'w-full min-w-0 h-11 rounded-xl border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const btn = 'h-11 px-4 rounded-full text-sm font-semibold shrink-0 disabled:opacity-50 inline-flex items-center justify-center gap-1.5';
const iconBtn = 'w-11 h-11 rounded-full flex items-center justify-center text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0 disabled:opacity-50';
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Settings › Members: who is in the organization; owners and admins invite by email (the full invite page is phase 4). */
export function MembersSection({ members, invitations, canInvite, isOwner }: { members: MemberRow[]; invitations: InviteRow[]; canInvite: boolean; isOwner: boolean }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [link, setLink] = useState<{ email: string; link: string; mailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
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

  return (
    <div className="space-y-5" data-members>
      <section>
        <h2 className="px-1 mb-1.5 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Members</h2>
        <div className="rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">
          {members.map(m => (
            <div key={m.userId} className="flex items-center gap-3 px-4 py-3 min-h-14" data-member={m.email}>
              <div className="flex-1 min-w-0">
                <div className="text-[15px] text-foreground truncate">
                  {m.name || m.email}
                  {m.you && <span className="text-muted-foreground"> (you)</span>}
                </div>
                <div className="text-[13px] text-muted-foreground truncate">{m.email}</div>
              </div>
              <span className="text-[13px] text-muted-foreground capitalize shrink-0">{m.role}</span>
            </div>
          ))}
        </div>
      </section>

      {canInvite && (
        <section>
          <h2 className="px-1 mb-1.5 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Invite</h2>
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
              <select className={`${field} w-auto`} value={role} onChange={e => setRole(e.target.value)} aria-label="Role">
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                {isOwner && <option value="owner">Owner</option>}
              </select>
              <button type="submit" className={`${btn} bg-foreground text-background`} disabled={pending}>
                <UserPlus className="w-4 h-4" /> Invite
              </button>
            </form>
          </div>
          {link && (
            <div className="mt-3 rounded-xl border border-border/70 p-3 space-y-2" data-invite-link>
              <p className="text-[13px] text-foreground">
                {link.mailed ? `Sent to ${link.email}. ` : `Email is not set up: send this link to ${link.email} yourself. `}The link works once, for 7 days.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 break-all rounded-lg bg-muted px-3 py-2 text-[12px] font-mono">{link.link}</code>
                <button
                  type="button"
                  className={iconBtn}
                  aria-label="Copy link"
                  onClick={() =>
                    navigator.clipboard?.writeText(link.link).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    })
                  }
                >
                  {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}
          <p className="px-1 mt-1.5 text-xs text-muted-foreground">Everyone in the organization sees its shared projects. Admins can invite; only an owner can make another owner.</p>
        </section>
      )}
    </div>
  );
}
