import { ScreenHeader } from '@/components/mobile/tab-bar';
import { ReviewNav, reviewView } from '@/components/review-nav';
import { Activity, Archived, Completed, Stale, Trash } from './views';

export const metadata = { title: 'Review · Work OS' };

type Props = { searchParams: Promise<{ view?: string; actor?: string; what?: string; weeks?: string }> };

/** The Review hub: one place for look-back jobs. The segment is in the URL (?view=). */
export default async function ReviewPage({ searchParams }: Props) {
  const sp = await searchParams;
  const view = reviewView(sp.view);
  const weeks = Math.min(52, Math.max(1, Number(sp.weeks) || 8));
  return (
    <div className="space-y-5 max-w-5xl">
      <ScreenHeader title="Review" sub="How work actually moved." back="/menu" backLabel="Menu" />
      <ReviewNav active={view} />
      {view === 'done' && <Completed weeks={weeks} />}
      {view === 'activity' && <Activity actor={sp.actor} what={sp.what} />}
      {view === 'stale' && <Stale />}
      {view === 'archive' && <Archived />}
      {view === 'trash' && <Trash />}
    </div>
  );
}
