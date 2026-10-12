import { notFound } from 'next/navigation';
import { slugToMode, getModeConfig } from '@/lib/modes';
import { readData } from '@/lib/storage';
import { ModePageClient } from './mode-page-client';

type Props = { params: Promise<{ mode: string }> };

export default async function ModePage({ params }: Props) {
  const { mode: slug } = await params;
  const modeName = slugToMode(slug);
  if (!modeName) notFound();

  const modeConfig = getModeConfig(modeName);
  const data = readData();
  const tasks = data.tasks.filter(t => t.mode === modeName);

  return (
    <ModePageClient
      modeName={modeName}
      modeConfig={modeConfig!}
      initialTasks={tasks}
    />
  );
}
