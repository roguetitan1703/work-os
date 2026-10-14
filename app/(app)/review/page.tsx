import { listReviews } from '@/lib/data/reviews';
import { ReviewPageClient } from './review-page-client';

export const metadata = { title: 'Weekly review · Work OS' };

export default async function ReviewPage() {
  const reviews = await listReviews();
  return <ReviewPageClient initialReviews={reviews} />;
}
