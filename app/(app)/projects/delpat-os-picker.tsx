'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { SharingChoice, type Sharing } from './sharing-choice';
import { importDelpatOsProjectAction, listDelpatOsProjectsAction } from './delpat-os-actions';

type Row = { id: string; title: string; client: string | null; status: string; role: string; workOsId: string | null };

/** New project › From Delpat OS: the person's Delpat OS projects with a search; picking one imports it (shared unless changed). */
export function DelpatOsPicker({ linked, onImported, onClose }: { linked: boolean; onImported: (projectId: string) => void; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [visibility, setVisibility] = useState<Sharing>('org');
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!linked) return;
    let alive = true;
    void listDelpatOsProjectsAction().then(r => {
      if (!alive) return;
      if (r.ok) setRows(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [linked]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (rows ?? []).filter(r => !t || `${r.title} ${r.client ?? ''} ${r.status}`.toLowerCase().includes(t));
  }, [rows, q]);

  if (!linked) {
    return (
      <p className="text-sm" data-delpat-unlinked>
        Link your Delpat OS account first.{' '}
        <Link href="/settings?section=connections" onClick={onClose} className="underline">
          Settings › Connections
        </Link>
      </p>
    );
  }
  return (
    <div className="space-y-3" data-delpat-picker>
      <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search your Delpat OS projects" aria-label="Search your Delpat OS projects" />
      {error && <p className="text-sm text-destructive" data-delpat-error>{error}</p>}
      {!rows && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {rows && !shown.length && <p className="text-sm text-muted-foreground">{rows.length ? 'Nothing matches.' : 'No projects found in Delpat OS.'}</p>}
      <ul className="space-y-2 max-h-72 overflow-y-auto">
        {shown.map(r => (
          <li key={r.id} data-delpat-project={r.id} className="flex items-center gap-3 rounded-xl border border-border/70 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{r.title}</div>
              <div className="text-xs text-muted-foreground truncate">{[r.client, r.status, r.role].filter(Boolean).join(' · ')}</div>
            </div>
            {r.workOsId ? (
              <Link href={`/projects/${r.workOsId}`} onClick={onClose} className="text-xs underline shrink-0" data-delpat-already>
                Already in Work OS ›
              </Link>
            ) : (
              <button
                type="button"
                disabled={pending}
                data-delpat-import
                className="h-9 px-3 rounded-full text-sm font-semibold border border-border disabled:opacity-50 shrink-0"
                onClick={() =>
                  start(async () => {
                    const res = await importDelpatOsProjectAction(r.id, visibility);
                    if (!res.ok) return void toast.error(res.error);
                    if (!res.data.created) toast.info(`"${res.data.project.name}" is already in Work OS`);
                    onImported(res.data.project.id);
                  })
                }
              >
                Import
              </button>
            )}
          </li>
        ))}
      </ul>
      <SharingChoice value={visibility} onChange={setVisibility} />
    </div>
  );
}
