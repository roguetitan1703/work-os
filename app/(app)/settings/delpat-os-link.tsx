import { requireCaller } from '@/lib/caller';
import { linkStatus } from '@/lib/delpat-os';
import { DelpatOsLinkButtons } from './delpat-os-link-buttons';

/** Settings › Connections: link or unlink your own Delpat OS account (to import projects from it). Nothing when this Work OS has no Delpat OS client set. */
export async function DelpatOsLink() {
  const caller = await requireCaller();
  const st = await linkStatus(caller);
  if (!st.enabled) return null;
  return (
    <section data-connection="delpat-os" className="rounded-2xl bg-card border border-border/70 px-4 py-3 space-y-2 min-w-0">
      <div className="text-[16px] font-medium text-foreground">Delpat OS</div>
      <p className="text-[13px] text-foreground/85" data-delpat-status>
        {st.linked ? 'Linked. New project › From Delpat OS lists your projects there.' : 'Not linked. Link your Delpat OS account to import your projects there into Work OS.'}
      </p>
      <DelpatOsLinkButtons linked={st.linked} />
    </section>
  );
}
