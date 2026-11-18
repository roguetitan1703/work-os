import { MobileHeader } from '@/components/mobile/tab-bar';
import { MyNeeds } from '@/components/needs';
import { requireCaller } from '@/lib/caller';
import { listNeeds, openNeedsToMe } from '@/lib/data/needs';

export const metadata = { title: 'Needs · Work OS' };

/** How long an answered Need stays under "Answered recently". */
const ANSWERED_DAYS = 14;

/** Needs (a phone tab; the sidebar on the desktop): what waits on the signed-in person (the same cards as Today's "Needs you"), then what they answered lately. */
export default async function NeedsPage() {
  const me = await requireCaller();
  const s = { userId: me.userId, orgId: me.orgId };
  const since = Date.now() - ANSWERED_DAYS * 86_400_000;
  const [open, answered] = await Promise.all([
    openNeedsToMe(s).catch(() => []),
    listNeeds(s, { to: s.userId, status: ['answered'], limit: 50 })
      .then(l => l.filter(n => n.answeredAt && Date.parse(n.answeredAt) >= since).sort((a, b) => (b.answeredAt ?? '').localeCompare(a.answeredAt ?? '')).slice(0, 20))
      .catch(() => []),
  ]);
  const subtitle = open.length ? `${open.length} waiting on you` : 'Nothing waits on you';
  return (
    <div className="max-w-xl md:max-w-3xl mx-auto">
      <MobileHeader title="Needs" subtitle={subtitle} />
      <div className="hidden md:block mb-4">
        <h1 className="text-2xl font-bold">Needs</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Decisions, approvals, reviews and asks waiting on you.</p>
      </div>
      <div className="mt-2 md:mt-0">
        <MyNeeds open={open} answered={answered} />
      </div>
    </div>
  );
}
