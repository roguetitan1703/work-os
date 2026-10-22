import { listReviews } from '@/lib/data/reviews';
import { requireScope } from '@/lib/caller';
import { getSchedule } from '@/lib/user-schedule';
import { SubHeader } from '@/components/mobile/sub-header';
import { ReviewNav, reviewView } from '@/components/review-nav';
import { ReviewPageClient } from './review-page-client';
import { Activity, Archived, Completed, Stale, Trash } from './views';

export const metadata = { title: 'Review · Work OS' };

type Props = { searchParams: Promise<{ view?: string; actor?: string; weeks?: string }> };

/** Weekly reviews with the person's own questions. */
async function Weekly() {
  const s = await requireScope();
  const [reviews, schedule] = await Promise.all([listReviews(s), getSchedule(s)]);
  return <ReviewPageClient initialReviews={reviews} questions={schedule.review} />;
}

/** The Review hub: one place for look-back jobs. The segment is in the URL (?view=). */
export default async function ReviewPage({ searchParams }: Props) {
  const sp = await searchParams;
  const view = reviewView(sp.view);
  const weeks = Math.min(52, Math.max(1, Number(sp.weeks) || 8));
  return (
    <div className="space-y-5 max-w-5xl">
      <SubHeader title="Review" subtitle="How work actually moved." />
      <div className="hidden md:block">
        <h1 className="text-2xl font-bold text-foreground">Review</h1>
        <p className="text-sm text-muted-foreground mt-0.5">How work actually moved.</p>
      </div>
      <ReviewNav active={view} />
      {view === 'done' && <Completed weeks={weeks} />}
      {view === 'activity' && <Activity actor={sp.actor} />}
      {view === 'weekly' && <Weekly />}
      {view === 'stale' && <Stale />}
      {view === 'archive' && <Archived />}
      {view === 'trash' && <Trash />}
    </div>
  );
}
