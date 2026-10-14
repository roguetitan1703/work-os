import Link from 'next/link';
import { Archive, Bell, ChevronRight, Clock, EyeOff, FolderOpen, History, LifeBuoy, Plug, Repeat2, Settings, Trash2 } from 'lucide-react';
import { listProjects } from '@/lib/data/projects';
import { MODES, modeToSlug } from '@/lib/modes';
import { MobileHeader } from '@/components/mobile/tab-bar';

export const metadata = { title: 'More · Work OS' };

/** Phone "More" tab: projects and everything that isn't a main tab. */
export default async function MorePage() {
  const projects = (await listProjects()).filter(p => p.stats.open > 0 || p.status === 'active').slice(0, 30);
  return (
    <div className="max-w-xl mx-auto">
      <MobileHeader title="More" />
      <h1 className="hidden md:block text-2xl font-bold mb-4">More</h1>

      <Group title="Projects">
        {projects.map(p => (
          <Item key={p.id} href={`/projects/${p.id}`} icon={<FolderOpen className="w-5 h-5 text-blue-500" />} label={p.name} value={p.stats.overdue ? `${p.stats.open} · ${p.stats.overdue} late` : String(p.stats.open)} tone={p.stats.overdue ? 'text-red-600 dark:text-red-400' : undefined} />
        ))}
        <Item href="/projects?all=1" icon={<Archive className="w-5 h-5 text-muted-foreground" />} label="All projects" />
      </Group>

      <Group title="Modes">
        {MODES.map(m => (
          <Item key={m.name} href={`/modes/${modeToSlug(m.name)}`} icon={<span className="w-5 h-5 flex items-center justify-center"><span className="w-3.5 h-3.5 rounded-full" style={{ backgroundColor: m.hex }} /></span>} label={m.name} />
        ))}
      </Group>

      <Group title="Work">
        <Item href="/history" icon={<History className="w-5 h-5 text-green-600" />} label="History" />
        <Item href="/archive" icon={<Archive className="w-5 h-5 text-slate-500" />} label="Archive" />
        <Item href="/hidden" icon={<EyeOff className="w-5 h-5 text-amber-500" />} label="Hidden work" />
        <Item href="/review" icon={<Repeat2 className="w-5 h-5 text-purple-500" />} label="Weekly review" />
        <Item href="/timetable" icon={<Clock className="w-5 h-5 text-sky-500" />} label="Timetable" />
        <Item href="/recovery" icon={<LifeBuoy className="w-5 h-5 text-pink-500" />} label="Recovery" />
        <Item href="/history?tab=trash" icon={<Trash2 className="w-5 h-5 text-muted-foreground" />} label="Trash" />
      </Group>

      <Group title="Settings">
        <Item href="/settings" icon={<Settings className="w-5 h-5 text-muted-foreground" />} label="Settings, notifications & status" />
        <Item href="/notifications" icon={<Bell className="w-5 h-5 text-red-500" />} label="Notifications" />
        <Item href="/connect" icon={<Plug className="w-5 h-5 text-orange-500" />} label="Connect Claude & Discord" />
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="px-1 mb-1.5 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      <div className="rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">{children}</div>
    </section>
  );
}

function Item({ href, icon, label, value, tone }: { href: string; icon: React.ReactNode; label: string; value?: string; tone?: string }) {
  return (
    <Link href={href} className="flex items-center gap-3 px-4 h-14 active:bg-muted/60">
      {icon}
      <span className="flex-1 min-w-0 truncate text-[16px] text-foreground">{label}</span>
      {value && <span className={`text-sm tabular-nums ${tone ?? 'text-muted-foreground'}`}>{value}</span>}
      <ChevronRight className="w-4 h-4 text-muted-foreground/40" />
    </Link>
  );
}
