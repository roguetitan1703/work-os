import { notFound } from 'next/navigation';
import { Gallery } from './gallery';

// Gallery of the shared UI library (components/ui): every piece in its states. Signed-in only (the (app) layout),
// not linked from navigation. Open it at /dev/ui. Hidden in production unless WOS_DEV_UI=1.
export const metadata = { title: 'UI library' };

export default async function DevUiPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  if (process.env.NODE_ENV === 'production' && process.env.WOS_DEV_UI !== '1') notFound();
  return <Gallery tab={tab ?? 'one'} />;
}
