import 'server-only';
import { randomUUID } from 'node:crypto';
import type { ReviewDoc, RitualDoc } from '../db';
import { scoped, type Scope } from '../scope';
import { FiverrRitualLogSchema, WeeklyReviewSchema, type FiverrRitualLog, type WeeklyReview } from '../types';
import { todayStr } from '../dates';

// Weekly reviews and ritual logs are each person's own (scope rule "own").
const toReview = ({ _id, orgId: _o, ownerId: _w, ...rest }: ReviewDoc): WeeklyReview => ({ id: _id, ...rest });
const toRitual = ({ _id, orgId: _o, ownerId: _w, ...rest }: RitualDoc): FiverrRitualLog => ({ id: _id, ...rest });

export async function listReviews(s: Scope): Promise<WeeklyReview[]> {
  const c = await scoped(s);
  const docs = await c.reviews.find({}).sort({ weekOf: -1 }).toArray();
  return docs.map(toReview);
}

export async function createReview(s: Scope, input: Omit<WeeklyReview, 'id'>): Promise<WeeklyReview> {
  const c = await scoped(s);
  const { id, ...rest } = WeeklyReviewSchema.parse({ ...input, id: randomUUID() });
  await c.reviews.insertOne({ _id: id, orgId: s.orgId, ownerId: s.userId, ...rest });
  return { id, ...rest };
}

export async function updateReview(s: Scope, id: string, patch: Partial<WeeklyReview>): Promise<void> {
  const c = await scoped(s);
  const cur = await c.reviews.findOne({ _id: id });
  if (!cur) return;
  const { id: _ignored, ...rest } = WeeklyReviewSchema.parse({ ...toReview(cur), ...patch, id });
  await c.reviews.updateOne({ _id: id }, { $set: rest });
}

export async function getRitualLog(s: Scope, date: string = todayStr()): Promise<FiverrRitualLog | null> {
  const c = await scoped(s);
  const d = await c.ritualLogs.findOne({ date });
  return d ? toRitual(d) : null;
}

export async function logFiverrRitual(s: Scope, input: { bidsPlaced: number; notes?: string }): Promise<FiverrRitualLog> {
  const c = await scoped(s);
  const date = todayStr();
  const existing = await c.ritualLogs.findOne({ date });
  const { id, ...rest } = FiverrRitualLogSchema.parse({ ...input, id: existing?._id ?? randomUUID(), date });
  await c.ritualLogs.updateOne({ _id: id }, { $set: rest }, { upsert: true });
  return { id, ...rest };
}
