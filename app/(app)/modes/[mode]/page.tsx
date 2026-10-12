import { notFound } from 'next/navigation';
import { slugToMode, getModeConfig } from '@/lib/modes';
import { listTasks } from '@/lib/data/tasks';
import type { Mode } from '@/lib/types';
import { ModePageClient } from './mode-page-client';

type Props = { params: Promise<{ mode: string }> };

export default async function ModePage({ params }: Props) {
  const { mode: slug } = await params;
  const modeName = slugToMode(slug);
  if (!modeName) notFound();

  const tasks = await listTasks({ mode: modeName as Mode });
  return <ModePageClient modeName={modeName} modeConfig={getModeConfig(modeName)!} initialTasks={tasks} />;
}
