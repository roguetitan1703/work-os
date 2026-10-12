import { z } from 'zod';

export const ModeSchema = z.enum([
  'Code & Dev',
  'Client Delivery',
  'Team Direction',
  'Outreach & Sales',
  'Growth',
  'Research & Planning',
  'Founder Decisions',
  'Business Admin',
]);
export type Mode = z.infer<typeof ModeSchema>;

export const PrioritySchema = z.enum(['P1', 'P2', 'P3', 'P4']);
export type Priority = z.infer<typeof PrioritySchema>;

export const StatusSchema = z.enum(['Not Started', 'In Progress', 'Blocked', 'Done', 'Dropped']);
export type Status = z.infer<typeof StatusSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  task: z.string().min(1),
  mode: ModeSchema,
  projectClient: z.string().optional().default(''),
  priority: PrioritySchema.default('P2'),
  estimateMins: z.number().int().nonnegative().default(30),
  due: z.string().optional(),
  status: StatusSchema.default('Not Started'),
  addedOn: z.string(),
  lastTouched: z.string(),
  doneDate: z.string().optional(),
  notes: z.string().optional().default(''),
});
export type Task = z.infer<typeof TaskSchema>;

export const WeeklyReviewSchema = z.object({
  id: z.string(),
  weekOf: z.string(),
  shipped: z.string().default(''),
  slipped: z.string().default(''),
  toDrop: z.string().default(''),
  brokenDays: z.number().int().default(0),
  extensionTokensUsed: z.number().int().default(0),
  adjustments: z.string().default(''),
});
export type WeeklyReview = z.infer<typeof WeeklyReviewSchema>;

export const FiverrRitualLogSchema = z.object({
  id: z.string(),
  date: z.string(), // ISO date YYYY-MM-DD
  bidsPlaced: z.number().int().nonnegative().default(0),
  notes: z.string().optional().default(''),
});
export type FiverrRitualLog = z.infer<typeof FiverrRitualLogSchema>;

export const DataFileSchema = z.object({
  tasks: z.array(TaskSchema).default([]),
  reviews: z.array(WeeklyReviewSchema).default([]),
  ritualLogs: z.array(FiverrRitualLogSchema).default([]),
});
export type DataFile = z.infer<typeof DataFileSchema>;
