'use client';

import { useState } from 'react';
import { Inbox, MoreHorizontal, Plus, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, List, Row } from '@/components/ui/card';
import { Chip, ChipGroup } from '@/components/ui/chip';
import { Disclosure } from '@/components/ui/disclosure';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, InlineAdd } from '@/components/ui/field';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Page, PageHeader } from '@/components/ui/page';
import { Section } from '@/components/ui/section';
import { Sheet, ConfirmSheet } from '@/components/ui/sheet';
import { StatusBadge, TONES, type StatusKey } from '@/components/ui/status-badge';
import { Tabs } from '@/components/ui/tabs';

const GROUPS: [string, StatusKey[]][] = [
  ['Session state', ['On', 'Working', 'Waiting on you', 'Idle', 'Off']],
  ['Task status', ['Not Started', 'In Progress', 'Blocked', 'Done', 'Dropped']],
  ['Need kind', ['decide', 'approve', 'review', 'do', 'chase']],
  ['Priority', ['P1', 'P2', 'P3', 'P4']],
];

export function Gallery({ tab }: { tab: string }) {
  const [chip, setChip] = useState('Today');
  const [sheet, setSheet] = useState<null | 'sheet' | 'confirm'>(null);
  const [added, setAdded] = useState<string[]>([]);
  const four = ['one', 'two', 'three', 'four'].map(k => ({ key: k, label: k[0].toUpperCase() + k.slice(1), href: `/dev/ui?tab=${k}` }));
  const six = ['Overview', 'Tasks', 'Notes', 'Needs', 'Sessions', 'Settings'].map(l => ({ key: l.toLowerCase(), label: l, href: `/dev/ui?tab=${l.toLowerCase()}`, count: l === 'Tasks' ? 12 : undefined }));
  return (
    <Page className="pb-10 space-y-8">
      <PageHeader title="UI library" sub="components/ui, every piece in its states" back="/menu" backLabel="Menu" actions={<IconButton label="Settings"><Settings /></IconButton>} />

      <Section label="Type steps and tokens">
        <Card className="p-4 space-y-1">
          <div className="text-page font-semibold">Page 28</div>
          <div className="text-title">Title 17</div>
          <div className="text-body">Body 15</div>
          <div className="text-meta text-muted-foreground">Meta 13</div>
          <div className="text-label text-muted-foreground">Label 11</div>
          <div className="flex gap-3 pt-3 text-meta">
            <div className="h-12 w-20 rounded-card bg-muted grid place-items-center">card</div>
            <div className="h-12 w-20 rounded-control bg-muted grid place-items-center">control</div>
            <div className="h-12 w-20 rounded-pill bg-muted grid place-items-center">pill</div>
          </div>
          <div className="pt-3 text-meta text-muted-foreground">Row height 44 on phones, 36 from md:</div>
          <div className="h-row rounded-control bg-muted px-3 flex items-center text-body">h-row</div>
        </Card>
      </Section>

      <Section label="Buttons" count={9}>
        <Card className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="touch">Primary</Button>
            <Button size="touch" variant="outline">Outline</Button>
            <Button size="touch" variant="secondary">Secondary</Button>
            <Button size="touch" variant="destructive">Destructive</Button>
            <Button size="touch" disabled>Disabled</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button>Default size</Button>
            <IconButton label="More"><MoreHorizontal /></IconButton>
            <IconButton label="Add" variant="outline"><Plus /></IconButton>
            <IconButton label="Off" disabled><Plus /></IconButton>
          </div>
        </Card>
      </Section>

      <Section label="Tabs">
        <div className="space-y-3">
          <Tabs items={four} active={four.some(t => t.key === tab) ? tab : 'one'} label="Four tabs" />
          <Tabs items={six} active={six.some(t => t.key === tab) ? tab : 'overview'} label="Six tabs scroll" />
        </div>
      </Section>

      <Section label="Chips" count={5}>
        <div className="space-y-3">
          <ChipGroup label="Due">
            {['Today', 'Tomorrow', 'Friday', 'Next week'].map(c => (
              <Chip key={c} selected={chip === c} onClick={() => setChip(c)}>{c}</Chip>
            ))}
            <Chip disabled>Disabled</Chip>
          </ChipGroup>
          <ChipGroup scroll label="Scrolling">
            {['Work OS', 'Delpat site', 'Grants', 'Outreach', 'Admin', 'Research', 'Founders'].map(c => (
              <Chip key={c} selected={c === 'Grants'}>{c}</Chip>
            ))}
          </ChipGroup>
        </div>
      </Section>

      <Section label="Status badges">
        <Card className="p-4 space-y-3">
          {GROUPS.map(([name, keys]) => (
            <div key={name} className="flex flex-wrap items-center gap-2">
              <span className="w-28 text-meta text-muted-foreground">{name}</span>
              {keys.map(k => (
                <StatusBadge key={k} status={k} />
              ))}
            </div>
          ))}
          <div className="text-label text-muted-foreground">{Object.keys(TONES).length} keys, one tone map</div>
        </Card>
      </Section>

      <Section label="List and rows" count={4} seeAll="/dev/ui" fold>
        <List>
          <Row title="File the grant report" meta="Grants, due Friday" trailing={<StatusBadge status="In Progress" />} href="/dev/ui" />
          <Row leading={<Inbox className="w-5 h-5" />} title="Title only, with a leading icon" />
          <Row title="A very long title that has to be cut off at the end of the line so the row stays one line high" meta="A long meta line that is also cut off at the end of its single line of text" trailing={<IconButton label="More"><MoreHorizontal /></IconButton>} onClick={() => {}} />
          <Row title="Needs you" meta="Approve the release" trailing={<StatusBadge status="approve" />} />
        </List>
      </Section>

      <Section label="Fields">
        <Card className="p-4 space-y-4">
          <Field label="Name" hint="Shown to your team.">{id => <Input id={id} placeholder="Your name" className="h-11 md:h-9 rounded-control" />}</Field>
          <Field label="Email" error="That is not an email address.">{id => <Input id={id} defaultValue="om@" aria-invalid className="h-11 md:h-9 rounded-control" />}</Field>
          <div className="space-y-2">
            <InlineAdd placeholder="Add a subtask" onAdd={t => setAdded(a => [...a, t])} />
            {added.length > 0 && <p className="text-meta text-muted-foreground">Added: {added.join(', ')}</p>}
          </div>
        </Card>
      </Section>

      <Section label="Empty state">
        <div className="grid gap-3 md:grid-cols-2">
          <EmptyState title="Nothing waits on you" hint="Decisions and approvals appear here." />
          <EmptyState icon={<Inbox className="w-5 h-5" />} title="No notes yet" hint="Notes you write show up here." action={<Button size="touch">New note</Button>} />
        </div>
      </Section>

      <Section label="Disclosure">
        <div className="space-y-2">
          <Disclosure title="More details" hint="Closed by default">Hidden content.</Disclosure>
          <Disclosure title="Advanced" open>Open content.</Disclosure>
        </div>
      </Section>

      <Section label="Sheet">
        <div className="flex flex-wrap gap-2">
          <Button size="touch" variant="outline" onClick={() => setSheet('sheet')}>Open sheet</Button>
          <Button size="touch" variant="outline" onClick={() => setSheet('confirm')}>Open confirm</Button>
        </div>
        {sheet === 'sheet' && (
          <Sheet title="A sheet" onClose={() => setSheet(null)}>
            <p className="text-body py-2">Bottom sheet on phones, dialog on desktop.</p>
          </Sheet>
        )}
        {sheet === 'confirm' && <ConfirmSheet title="Delete it?" message="This goes to the trash." verb="Delete" danger onConfirm={() => setSheet(null)} onClose={() => setSheet(null)} />}
      </Section>
    </Page>
  );
}
