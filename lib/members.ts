import 'server-only';
import { headers } from 'next/headers';
import { ObjectId } from 'mongodb';
import { SafeError, appBaseUrl } from './auth';
import { getAuth, hashToken, idIn, INVITE_DAYS, MAX_PASSWORD, MIN_PASSWORD, newToken, ROLES, type Role } from './auth-server';
import { forgetRoles, type Caller } from './caller';
import { getDb } from './db';
import { mailConfigured, mailErrorMessage, sendMail, takeMailSlot } from './mail';
import { forgetMembers } from './people';
import { revokeKeysIn } from './api-keys';
import { releaseMember } from './data/team';
import { closeFor } from './live';

// Members and invitations (docs/auth.md, docs/multi-user.md phase 4). Sign-up is closed: a person gets an account by
// accepting an invitation. An invitation link is /accept-invitation/<invitation id>?t=<secret>; only the SHA-256 of the
// secret is stored (invitation.tokenHash), so the id alone (which owners and admins can list) never accepts anything.
// Settings › Members: owners and admins invite, cancel invitations, change roles and remove members.
//
// Roles: owner, admin, member. Only an owner makes someone an owner, or changes or removes an owner. An organization
// always keeps one owner. Removing a member ends their access at once (releaseAccess).

export type MemberRow = { userId: string; name: string; email: string; role: Role; joinedAt: string; you: boolean };
export type InviteRow = { id: string; email: string; role: Role; expiresAt: string };

/**
 * The one switch for invitation links (docs/auth.md). On (the default, `INVITE_LINK_TO_INVITER` unset or `1`): the
 * person who invites also sees the link, to copy when email is off or slow. Off (`0`): the link only goes by email, so an
 * owner or admin can never open an invitee's link and claim their account; inviting then needs working email.
 */
export function inviteLinkToInviter(): boolean {
  return process.env.INVITE_LINK_TO_INVITER !== '0';
}
export type InviteView = { id: string; email: string; role: Role; orgName: string; accountExists: boolean };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/;
const asRole = (r: unknown): Role => ((ROLES as readonly string[]).includes(String(r)) ? (r as Role) : 'member');
const oid = (id: string) => (ObjectId.isValid(id) && id.length === 24 ? new ObjectId(id) : null);

export async function listMembers(c: Caller): Promise<{ members: MemberRow[]; invitations: InviteRow[] }> {
  const db = await getDb();
  const members = await db.collection('member').find({ organizationId: idIn(c.orgId) }).sort({ createdAt: 1 }).toArray();
  const users = await db.collection('user').find({ _id: { $in: members.map(m => m.userId) } }, { projection: { name: 1, email: 1 } }).toArray();
  const byId = new Map(users.map(u => [String(u._id), u]));
  const canSeeInvites = c.role === 'owner' || c.role === 'admin';
  const invitations = canSeeInvites
    ? await db.collection('invitation').find({ organizationId: idIn(c.orgId), status: 'pending', expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).toArray()
    : [];
  return {
    members: members.map(m => {
      const u = byId.get(String(m.userId));
      return { userId: String(m.userId), name: u?.name ?? '', email: u?.email ?? '', role: asRole(m.role), joinedAt: new Date(m.createdAt).toISOString(), you: String(m.userId) === c.userId };
    }),
    invitations: invitations.map(i => ({ id: String(i._id), email: String(i.email), role: asRole(i.role), expiresAt: new Date(i.expiresAt).toISOString() })),
  };
}

/**
 * Invites `email` to the caller's organization. Owners and admins; only an owner can invite an owner. link is null when
 * the switch above keeps links to email only.
 */
export async function inviteMember(c: Caller, emailIn: string, roleIn: string): Promise<{ link: string | null; mailed: boolean }> {
  if (c.via !== 'session') throw new SafeError('Only a signed-in person can invite.');
  if (c.role !== 'owner' && c.role !== 'admin') throw new SafeError('Only an owner or admin can invite.');
  const email = String(emailIn ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw new SafeError('Enter an email address.');
  const role = asRole(roleIn);
  if (role === 'owner' && c.role !== 'owner') throw new SafeError('Only an owner can invite another owner.');
  const base = appBaseUrl();
  if (!base) throw new SafeError('APP_URL is not set, so no invitation link can be made.');
  const showLink = inviteLinkToInviter();
  if (!showLink && !mailConfigured()) throw new SafeError('Email is not set up, and invitation links are sent only by email here. Set up email first.');

  const auth = await getAuth();
  const h = await headers();
  let inv: { id: string };
  try {
    inv = (await auth.api.createInvitation({ headers: h, body: { email, role, organizationId: c.orgId } })) as { id: string };
  } catch (e) {
    throw new SafeError(e instanceof Error && e.message ? e.message : 'Could not invite that address.');
  }
  const token = newToken();
  const db = await getDb();
  await db.collection('invitation').updateOne({ _id: idIn(inv.id) }, { $set: { tokenHash: hashToken(token) } });
  const link = `${base}/accept-invitation/${inv.id}?t=${token}`;

  let mailed = false;
  if (mailConfigured() && (await takeMailSlot('invite', email))) {
    const org = await db.collection('organization').findOne({ _id: idIn(c.orgId) });
    try {
      await sendMail({
        to: email,
        subject: `You're invited to ${org?.name ?? 'Work OS'} on Work OS`,
        text: `${c.name || c.email} invited you to ${org?.name ?? 'their organization'} on Work OS as ${role}.\n\nOpen this link within ${INVITE_DAYS} days to set your password and join:\n${link}\n\nIf you weren't expecting this, ignore it.`,
      });
      mailed = true;
    } catch (e) {
      console.error('invitation email failed:', mailErrorMessage(e));
    }
  }
  if (!showLink && !mailed) {
    // Nobody holds the link: cancel the invitation rather than leave one that cannot be used.
    await db.collection('invitation').updateOne({ _id: idIn(inv.id), status: 'pending' }, { $set: { status: 'canceled' } });
    throw new SafeError('The invitation email could not be sent (too many emails this hour, or the mail server refused). Try again later.');
  }
  return { link: showLink ? link : null, mailed };
}

// ── Roles and removal ───────────────────────────────────────────────────────

type MemberDoc = { _id: ObjectId; userId: unknown; organizationId: unknown; role: string; createdAt: Date };

async function memberOf(orgId: string, userId: string): Promise<MemberDoc | null> {
  if (!oid(userId)) return null;
  const db = await getDb();
  return (await db.collection('member').findOne({ organizationId: idIn(orgId), userId: idIn(userId) })) as MemberDoc | null;
}

async function ownerCount(orgId: string): Promise<number> {
  const db = await getDb();
  return db.collection('member').countDocuments({ organizationId: idIn(orgId), role: 'owner' });
}

/**
 * Who may change or remove this member: owners anyone; admins only admins and members (never an owner). The caller's own
 * role is read fresh from the database, not the cached one (a demotion a moment ago must count).
 */
async function assertManages(c: Caller, target: MemberDoc, next?: Role): Promise<void> {
  if (c.via !== 'session') throw new SafeError('Only a signed-in person can change members.');
  const mine = await memberOf(c.orgId, c.userId);
  const role = mine ? asRole(mine.role) : null;
  if (role !== 'owner' && role !== 'admin') throw new SafeError('Only an owner or admin can change members.');
  if (role !== 'owner' && asRole(target.role) === 'owner') throw new SafeError('Only an owner can change or remove an owner.');
  if (next === 'owner' && role !== 'owner') throw new SafeError('Only an owner can make someone an owner.');
}

const LAST_OWNER = 'An organization needs an owner. Make someone else an owner first.';

/**
 * Sets a member's role. The last owner cannot be demoted: the write is checked after it is made and undone if it left
 * no owner, so two owners demoting each other at once cannot both succeed.
 */
export async function changeRole(c: Caller, userId: string, roleIn: string): Promise<void> {
  const role = (ROLES as readonly string[]).includes(String(roleIn)) ? (roleIn as Role) : null;
  if (!role) throw new SafeError('Pick owner, admin or member.');
  const m = await memberOf(c.orgId, String(userId ?? ''));
  if (!m) throw new SafeError('That person is not a member of this organization.');
  await assertManages(c, m, role);
  const was = asRole(m.role);
  if (was === role) return;
  const db = await getDb();
  if (was === 'owner' && (await ownerCount(c.orgId)) <= 1) throw new SafeError(LAST_OWNER);
  await db.collection('member').updateOne({ _id: m._id, role: m.role }, { $set: { role } });
  if (was === 'owner' && (await ownerCount(c.orgId)) < 1) {
    await db.collection('member').updateOne({ _id: m._id }, { $set: { role: 'owner' } });
    throw new SafeError(LAST_OWNER);
  }
  forgetRoles();
}

/**
 * Removes a member and ends their access to this organization at once: the membership, their sessions open in it, their
 * Claude keys for it, their computers there and the tasks they gave to Claude (lib/data/team.ts). Their private things
 * are kept as they are, reachable by nobody (docs/multi-user.md phase 4). You cannot remove yourself here.
 */
export async function removeMember(c: Caller, userId: string): Promise<{ computers: number; keys: number; claims: number; unassigned: number }> {
  const m = await memberOf(c.orgId, String(userId ?? ''));
  if (!m) throw new SafeError('That person is not a member of this organization.');
  if (String(m.userId) === c.userId) throw new SafeError('You cannot remove yourself. Ask another owner or admin.');
  await assertManages(c, m);
  // An owner is first made a member through the same guarded step, so the last owner can never be removed.
  if (asRole(m.role) === 'owner') await changeRole(c, String(m.userId), 'member');
  const db = await getDb();
  await db.collection('member').deleteOne({ _id: m._id });
  return releaseAccess(c.orgId, String(m.userId));
}

/** Everything that let userId act in orgId stops: sessions there, invitations they sent, keys, computers, claims, queued alerts; caches cleared. */
async function releaseAccess(orgId: string, userId: string): Promise<{ computers: number; keys: number; claims: number; unassigned: number }> {
  forgetRoles();
  forgetMembers(orgId);
  const db = await getDb();
  // Sessions whose active organization is this one (their sessions in other organizations stay).
  await db.collection('session').deleteMany({ userId: idIn(userId), activeOrganizationId: idIn(orgId) });
  // Invitations they sent and that are still open die with their access (they may hold the links).
  await db.collection('invitation').updateMany({ organizationId: idIn(orgId), inviterId: idIn(userId), status: 'pending' }, { $set: { status: 'canceled' } });
  const keys = await revokeKeysIn(userId, orgId);
  const rest = await releaseMember(orgId, userId);
  // Their open pages and workers lose their push streams now (a reconnect is refused: no session, no membership).
  closeFor(orgId, userId);
  return { keys, ...rest };
}

export async function cancelInvitation(c: Caller, id: string): Promise<void> {
  if (c.role !== 'owner' && c.role !== 'admin') throw new SafeError('Only an owner or admin can cancel an invitation.');
  // Another organization's invitation answers like one that does not exist (Better Auth would say "Member not found",
  // telling the caller the id is real).
  const db = await getDb();
  if (!(await db.collection('invitation').findOne({ _id: idIn(String(id ?? '')), organizationId: idIn(c.orgId) }, { projection: { _id: 1 } }))) {
    throw new SafeError('Invitation not found');
  }
  const auth = await getAuth();
  try {
    await auth.api.cancelInvitation({ headers: await headers(), body: { invitationId: String(id) } });
  } catch (e) {
    throw new SafeError(e instanceof Error && e.message ? e.message : 'Could not cancel that invitation.');
  }
}

// ── Accepting (app/accept-invitation, public) ───────────────────────────────

type InvDoc = { _id: ObjectId; email: string; role: string; organizationId: unknown; status: string; expiresAt: Date; tokenHash?: string };

async function openInvitation(id: string, token: string): Promise<InvDoc | null> {
  const _id = oid(id);
  if (!_id || typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const db = await getDb();
  const inv = (await db.collection('invitation').findOne({ _id })) as InvDoc | null;
  if (!inv || inv.status !== 'pending' || new Date(inv.expiresAt).getTime() < Date.now() || !inv.tokenHash) return null;
  return inv.tokenHash === hashToken(token) ? inv : null;
}

/** What the accept page shows, or null when the link is wrong, used, cancelled or expired. */
export async function viewInvitation(id: string, token: string): Promise<InviteView | null> {
  const inv = await openInvitation(id, token);
  if (!inv) return null;
  const db = await getDb();
  const [org, user] = await Promise.all([db.collection('organization').findOne({ _id: idIn(String(inv.organizationId)) }), db.collection('user').findOne({ email: inv.email.toLowerCase() })]);
  return { id, email: inv.email, role: asRole(inv.role), orgName: String(org?.name ?? 'Work OS'), accountExists: !!user };
}

/** Marks the invitation accepted (once) and returns it; null if someone else got there first or the link is bad. */
async function claim(id: string, token: string): Promise<InvDoc | null> {
  const inv = await openInvitation(id, token);
  if (!inv) return null;
  const db = await getDb();
  const r = await db.collection('invitation').findOneAndUpdate({ _id: inv._id, status: 'pending', tokenHash: inv.tokenHash }, { $set: { status: 'accepted' } });
  return r ? inv : null;
}

async function release(inv: InvDoc): Promise<void> {
  const db = await getDb();
  await db.collection('invitation').updateOne({ _id: inv._id, status: 'accepted' }, { $set: { status: 'pending' } });
}

async function addMember(userId: string, orgId: string, role: Role): Promise<void> {
  const db = await getDb();
  if (await db.collection('member').findOne({ userId: idIn(userId), organizationId: idIn(orgId) })) return;
  const ctx = await (await getAuth()).$context;
  await ctx.adapter.create({ model: 'member', data: { organizationId: orgId, userId, role, createdAt: new Date() } });
  forgetRoles();
  forgetMembers(orgId);
}

/** A new person: creates their account (email from the invitation), joins them, signs them in. */
export async function acceptAsNewUser(id: string, token: string, nameIn: string, password: string): Promise<void> {
  const name = String(nameIn ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!name) throw new SafeError('Enter your name.');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new SafeError(`Use a password of at least ${MIN_PASSWORD} characters.`);
  if (password.length > MAX_PASSWORD) throw new SafeError('That password is too long.');
  const inv = await claim(id, token);
  if (!inv) throw new SafeError('This invitation link is invalid, expired or already used.');
  const auth = await getAuth();
  const ctx = await auth.$context;
  const email = inv.email.toLowerCase();
  try {
    if (await ctx.internalAdapter.findUserByEmail(email)) throw new SafeError('There is already an account for this address. Sign in to accept.');
    const user = await ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: 'email-password' });
    if (!user) throw new Error('user not created');
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: await ctx.password.hash(password) });
    await addMember(String(user.id), String(inv.organizationId), asRole(inv.role));
  } catch (e) {
    await release(inv);
    throw e;
  }
  // Signs in on this response (nextCookies); the new session opens in the invited organization.
  await auth.api.signInEmail({ body: { email, password }, headers: await headers() });
}

/** Someone with an account, signed in as the invited address: joins and switches to the organization. */
export async function acceptAsSignedIn(id: string, token: string, c: Caller | null): Promise<void> {
  if (!c) throw new SafeError('Sign in first.');
  const view = await openInvitation(id, token);
  if (!view) throw new SafeError('This invitation link is invalid, expired or already used.');
  if (view.email.toLowerCase() !== c.email.toLowerCase()) throw new SafeError(`This invitation is for ${view.email}. Sign in as that address to accept it.`);
  const inv = await claim(id, token);
  if (!inv) throw new SafeError('This invitation link is invalid, expired or already used.');
  try {
    await addMember(c.userId, String(inv.organizationId), asRole(inv.role));
  } catch (e) {
    await release(inv);
    throw e;
  }
  const auth = await getAuth();
  await auth.api.setActiveOrganization({ headers: await headers(), body: { organizationId: String(inv.organizationId) } }).catch(() => {});
}
