import 'server-only';
import { randomUUID } from 'node:crypto';
import { collections, type ReviewDoc, type RitualDoc } from '../db';
import { FiverrRitualLogSchema, WeeklyReviewSchema, type FiverrRitualLog, type WeeklyReview } from '../types';
import { todayStr } from '../dates';

const toReview = ({ _id, ...rest }: ReviewDoc): WeeklyReview => ({ id: _id, ...rest });
const toRitual = ({ _id, ...rest }: RitualDoc): FiverrRitualLog => ({ id: _id, ...rest });

export async function listReviews(): Promise<WeeklyReview[]> {
  const c = await collections();
  const docs = await c.reviews.find({}).sort({ weekOf: -1 }).toArray();
  return docs.map(toReview);
}

export async function createReview(input: Omit<WeeklyReview, 'id'>): Promise<WeeklyReview> {
  const c = await collections();
  const { id, ...rest } = WeeklyReviewSchema.parse({ ...input, id: randomUUID() });
  await c.reviews.insertOne({ _id: id, ...rest });
  return { id, ...rest };
}

export async function updateReview(id: string, patch: Partial<WeeklyReview>): Promise<void> {
  const c = await collections();
  const cur = await c.reviews.findOne({ _id: id });
  if (!cur) return;
  const { id: _ignored, ...rest } = WeeklyReviewSchema.parse({ ...toReview(cur), ...patch, id });
  await c.reviews.updateOne({ _id: id }, { $set: rest });
}

export async function getRitualLog(date: string = todayStr()): Promise<FiverrRitualLog | null> {
  const c = await collections();
  const d = await c.ritualLogs.findOne({ date });
  return d ? toRitual(d) : null;
}

export async function logFiverrRitual(input: { bidsPlaced: number; notes?: string }): Promise<FiverrRitualLog> {
  const c = await collections();
  const date = todayStr();
  const existing = await c.ritualLogs.findOne({ date });
  const { id, ...rest } = FiverrRitualLogSchema.parse({ ...input, id: existing?._id ?? randomUUID(), date });
  await c.ritualLogs.updateOne({ _id: id }, { $set: rest }, { upsert: true });
  return { id, ...rest };
}
