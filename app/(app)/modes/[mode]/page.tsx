import { notFound, redirect } from 'next/navigation';
import { slugToMode } from '@/lib/modes';
import { modeHref } from '@/lib/nav';

type Props = { params: Promise<{ mode: string }> };

/** The mode pages are a filter on Tasks now; old links land there. */
export default async function ModePage({ params }: Props) {
  const { mode: slug } = await params;
  const modeName = slugToMode(slug);
  if (!modeName) notFound();
  redirect(modeHref(modeName));
}
