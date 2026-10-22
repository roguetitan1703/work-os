import 'server-only';
import { randomUUID } from 'node:crypto';
import type { ReviewDoc, RitualDoc } from '../db';
import { scoped, type Scope } from '../scope';
import { RoutineLogSchema, WeeklyReviewSchema, type RoutineLog, type WeeklyReview } from '../types';
import { todayStr } from '../dates';

// Weekly reviews and routine logs are each person's own (scope rule "own"). The questions a review answers and the
// routine are the person's (lib/schedule.ts); a review stores answers by question key.

/** Answer fields of reviews written before phase 3 (now answers.<key>). */
export const LEGACY_REVIEW_KEYS = ['shipped', 'slipped', 'toDrop', 'brokenDays', 'extensionTokensUsed', 'adjustments'] as const;

function toReview(d: ReviewDoc): WeeklyReview {
  const legacy: WeeklyReview['answers'] = {};
  for (const k of LEGACY_REVIEW_KEYS) {
    const v = d[k];
    if (typeof v === 'string' || typeof v === 'number') legacy[k] = v;
  }
  return { id: d._id, weekOf: d.weekOf, answers: { ...legacy, ...(d.answers ?? {}) } };
}
const toRoutine = (d: RitualDoc): RoutineLog => ({ id: d._id, date: d.date, count: d.count ?? d.bidsPlaced ?? 0, notes: d.notes ?? '' });

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

export async function updateReview(s: Scope, id: string, patch: Partial<Omit<WeeklyReview, 'id'>>): Promise<void> {
  const c = await scoped(s);
  const cur = await c.reviews.findOne({ _id: id });
  if (!cur) return;
  const { id: _ignored, ...rest } = WeeklyReviewSchema.parse({ ...toReview(cur), ...patch, id });
  await c.reviews.updateOne({ _id: id }, { $set: rest, $unset: Object.fromEntries(LEGACY_REVIEW_KEYS.map(k => [k, ''])) });
}

export async function getRoutineLog(s: Scope, date: string = todayStr()): Promise<RoutineLog | null> {
  const c = await scoped(s);
  const d = await c.ritualLogs.findOne({ date });
  return d ? toRoutine(d) : null;
}

export async function logRoutine(s: Scope, input: { count: number; notes?: string }): Promise<RoutineLog> {
  const c = await scoped(s);
  const date = todayStr();
  const existing = await c.ritualLogs.findOne({ date });
  const { id, ...rest } = RoutineLogSchema.parse({ ...input, id: existing?._id ?? randomUUID(), date });
  await c.ritualLogs.updateOne({ _id: id }, { $set: rest, $unset: { bidsPlaced: '' } }, { upsert: true });
  return { id, ...rest };
}
