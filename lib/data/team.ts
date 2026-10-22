import 'server-only';
import { orgWide, scoped, forUser } from '../scope';

// What leaving an organization does to its work data (docs/multi-user.md "As built: phase 4"). lib/members.ts removes
// the membership, sessions and keys (Better Auth's collections); this is the part in Work OS's own collections, through
// the door. The person's private things (private projects, tasks, notes, settings, inbox) are kept untouched: nobody
// else can reach them, and they come back if the person is invited again.

/**
 * After userId left orgId: their computers there are revoked (pending jobs cancelled), tasks they gave to Claude stop
 * (queued and running claims end as "stopped"), unsent alerts to them are dropped, and shared tasks assigned to them go back to their owners' alerts.
 * Returns counts for the caller's message.
 */
export async function releaseMember(orgId: string, userId: string): Promise<{ computers: number; claims: number; unassigned: number }> {
  const now = new Date();
  const theirs = await scoped(forUser({ orgId }, userId));
  const devices = await theirs.devices.find({ revokedAt: null }, { projection: { _id: 1 } }).toArray();
  if (devices.length) {
    await theirs.devices.updateMany({ _id: { $in: devices.map(d => d._id) } }, { $set: { revokedAt: now } });
    await theirs.workerJobs.updateMany({ deviceId: { $in: devices.map(d => d._id) }, doneAt: null }, { $set: { doneAt: now, ok: false, error: 'member removed' } });
  }
  // Alerts queued for them and not sent yet (an assignment, a finished Claude task) are dropped.
  await theirs.alertQueue.deleteMany({ sentAt: null });
  // System work over the whole organization: their claims may sit on shared tasks, and assignments are on others' tasks.
  const org = await orgWide(orgId);
  const claims = await org.tasks.updateMany(
    { 'claude.markedByUserId': userId, 'claude.state': { $in: ['queued', 'running'] } },
    { $set: { 'claude.state': 'stopped', 'claude.endedAt': now, 'claude.note': 'the person who gave it left the organization' } },
  );
  const unassigned = await org.tasks.updateMany({ assigneeId: userId }, { $set: { assigneeId: null } });
  return { computers: devices.length, claims: claims.modifiedCount, unassigned: unassigned.modifiedCount };
}
