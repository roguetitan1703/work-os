import { readData } from '@/lib/storage';
import { ReviewPageClient } from './review-page-client';

export default function ReviewPage() {
  const data = readData();
  const reviews = [...data.reviews].sort((a, b) => b.weekOf.localeCompare(a.weekOf));
  return <ReviewPageClient initialReviews={reviews} />;
}
