'use client';

import { useState, useTransition } from 'react';
import { format, parseISO, startOfWeek } from 'date-fns';
import { toast } from 'sonner';
import { WeeklyReview } from '@/lib/types';
import { createReview, updateReview } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, ChevronDown, ChevronRight, Repeat2 } from 'lucide-react';
import { MEmpty } from '@/components/mobile/sub-header';
import { FullSheet } from '@/components/mobile/full-sheet';
import { usePhone } from '@/components/mobile/use-phone';

function lastSunday(): string {
  const today = new Date();
  const sun = startOfWeek(today, { weekStartsOn: 0 });
  return format(sun, 'yyyy-MM-dd');
}

type ReviewFormData = Omit<WeeklyReview, 'id'>;

function emptyForm(): ReviewFormData {
  return {
    weekOf: lastSunday(),
    shipped: '',
    slipped: '',
    toDrop: '',
    brokenDays: 0,
    extensionTokensUsed: 0,
    adjustments: '',
  };
}

type Props = { initialReviews: WeeklyReview[] };

export function ReviewPageClient({ initialReviews }: Props) {
  const [reviews, setReviews] = useState(initialReviews);
  const [newOpen, setNewOpen] = useState(false);
  const [newForm, setNewForm] = useState<ReviewFormData>(emptyForm());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editForms, setEditForms] = useState<Record<string, Partial<WeeklyReview>>>({});
  const [pending, startTransition] = useTransition();
  const phone = usePhone();

  function setNewField<K extends keyof ReviewFormData>(k: K, v: ReviewFormData[K]) {
    setNewForm(prev => ({ ...prev, [k]: v }));
  }

  function handleCreate() {
    startTransition(async () => {
      try {
        const created = await createReview(newForm);
        setReviews(prev => [created, ...prev]);
        setNewOpen(false);
        setNewForm(emptyForm());
        toast.success('Review saved.');
      } catch {
        toast.error('Failed to save review.');
      }
    });
  }

  function startEdit(r: WeeklyReview) {
    setEditForms(prev => ({ ...prev, [r.id]: { ...r } }));
    setExpandedId(r.id);
  }

  function setEditField(id: string, k: keyof WeeklyReview, v: unknown) {
    setEditForms(prev => ({ ...prev, [id]: { ...prev[id], [k]: v } }));
  }

  function handleUpdate(id: string) {
    startTransition(async () => {
      try {
        await updateReview(id, editForms[id]);
        setReviews(prev => prev.map(r => r.id === id ? { ...r, ...editForms[id] } : r));
        setEditForms(prev => { const n = { ...prev }; delete n[id]; return n; });
        toast.success('Review updated.');
      } catch {
        toast.error('Failed to update review.');
      }
    });
  }

  const newFields = (
    <div className="space-y-4">
      <ReviewField label="Week of" type="date" value={newForm.weekOf} onChange={v => setNewField('weekOf', v)} />
      <ReviewField label="Shipped" multiline value={newForm.shipped} onChange={v => setNewField('shipped', v)} placeholder="What shipped this week?" />
      <ReviewField label="Slipped" multiline value={newForm.slipped} onChange={v => setNewField('slipped', v)} placeholder="What didn't ship?" />
      <ReviewField label="To Drop" multiline value={newForm.toDrop} onChange={v => setNewField('toDrop', v)} placeholder="What should be dropped?" />
      <div className="grid grid-cols-2 gap-3">
        <ReviewField label="Broken Days" type="number" value={String(newForm.brokenDays)} onChange={v => setNewField('brokenDays', parseInt(v) || 0)} />
        <ReviewField label="Extension Tokens Used" type="number" value={String(newForm.extensionTokensUsed)} onChange={v => setNewField('extensionTokensUsed', parseInt(v) || 0)} />
      </div>
      <ReviewField label="Adjustments" multiline value={newForm.adjustments} onChange={v => setNewField('adjustments', v)} placeholder="What changes next week?" />
    </div>
  );

  return (
    <div className="space-y-5 md:space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm md:text-xs text-muted-foreground">{reviews.length} reviews logged</p>
        <Button size="sm" className="gap-1.5 max-md:h-11 max-md:px-4 max-md:text-sm" onClick={() => setNewOpen(true)}>
          <Plus className="w-3.5 h-3.5" />
          New review
        </Button>
      </div>

      {reviews.length === 0 && (
        <>
          <div className="md:hidden">
            <MEmpty icon={<Repeat2 className="w-5 h-5" />} title="No reviews yet" hint="Tap + to log your first weekly review." />
          </div>
          <div className="hidden md:block text-sm text-muted-foreground py-12 text-center">No reviews yet. Start your first one.</div>
        </>
      )}

      <div className="space-y-2">
        {reviews.map(r => {
          const isExpanded = expandedId === r.id;
          const ef = editForms[r.id] ?? r;

          return (
            <div key={r.id} className="border border-border/70 md:border-border rounded-2xl md:rounded-lg overflow-hidden bg-card">
              <button
                className="w-full flex items-center justify-between gap-3 px-4 py-3 min-h-14 bg-card hover:bg-muted/50 active:bg-muted/60 text-left transition-colors"
                onClick={() => {
                  setExpandedId(isExpanded ? null : r.id);
                  if (!isExpanded && !(r.id in editForms)) startEdit(r);
                }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {isExpanded
                    ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                    : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                  <div className="min-w-0">
                    <div className="font-semibold text-[16px] md:text-base text-foreground">
                      Week of {format(parseISO(r.weekOf), 'MMM d, yyyy')}
                    </div>
                    <div className="md:hidden text-sm text-muted-foreground">
                      {r.brokenDays} broken day{r.brokenDays !== 1 ? 's' : ''} · {r.extensionTokensUsed} token{r.extensionTokensUsed !== 1 ? 's' : ''} used
                    </div>
                  </div>
                </div>
                <div className="hidden md:flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{r.brokenDays} broken day{r.brokenDays !== 1 ? 's' : ''}</span>
                  <span>{r.extensionTokensUsed} token{r.extensionTokensUsed !== 1 ? 's' : ''} used</span>
                </div>
              </button>

              {isExpanded && (
                <div className="px-4 py-4 border-t bg-muted/30 space-y-4">
                  <ReviewField label="Week of" type="date" value={ef.weekOf as string ?? ''} onChange={v => setEditField(r.id, 'weekOf', v)} />
                  <ReviewField label="Shipped" multiline value={ef.shipped as string ?? ''} onChange={v => setEditField(r.id, 'shipped', v)} placeholder="What shipped this week?" />
                  <ReviewField label="Slipped" multiline value={ef.slipped as string ?? ''} onChange={v => setEditField(r.id, 'slipped', v)} placeholder="What didn't ship?" />
                  <ReviewField label="To Drop" multiline value={ef.toDrop as string ?? ''} onChange={v => setEditField(r.id, 'toDrop', v)} placeholder="What should be dropped?" />
                  <div className="grid grid-cols-2 gap-3">
                    <ReviewField label="Broken Days" type="number" value={String(ef.brokenDays ?? 0)} onChange={v => setEditField(r.id, 'brokenDays', parseInt(v) || 0)} />
                    <ReviewField label="Extension Tokens Used" type="number" value={String(ef.extensionTokensUsed ?? 0)} onChange={v => setEditField(r.id, 'extensionTokensUsed', parseInt(v) || 0)} />
                  </div>
                  <ReviewField label="Adjustments" multiline value={ef.adjustments as string ?? ''} onChange={v => setEditField(r.id, 'adjustments', v)} placeholder="What changes next week?" />
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" className="max-md:h-11 max-md:flex-1" onClick={() => {
                      setEditForms(prev => { const n = { ...prev }; delete n[r.id]; return n; });
                      setExpandedId(null);
                    }}>Cancel</Button>
                    <Button size="sm" className="max-md:h-11 max-md:flex-1" onClick={() => handleUpdate(r.id)} disabled={pending}>Save</Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {phone ? (
        newOpen && (
          <FullSheet
            title="New weekly review"
            onClose={() => setNewOpen(false)}
            footer={
              <button onClick={handleCreate} disabled={pending} className="w-full h-12 rounded-2xl bg-foreground text-background text-base font-semibold disabled:opacity-40 active:scale-[0.98] transition-transform">
                Save review
              </button>
            }
          >
            {newFields}
          </FullSheet>
        )
      ) : (
        <Dialog open={newOpen} onOpenChange={v => !v && setNewOpen(false)}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>New Weekly Review</DialogTitle>
            </DialogHeader>
            {newFields}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setNewOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={pending}>Save Review</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function ReviewField({
  label, value, onChange, multiline, type = 'text', placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm md:text-xs">{label}</Label>
      {multiline ? (
        <Textarea value={value} onChange={e => onChange(e.target.value)} rows={3} placeholder={placeholder} className="text-[16px] md:text-sm" />
      ) : (
        <Input type={type} value={value} onChange={e => onChange(e.target.value)} inputMode={type === "number" ? "numeric" : undefined} className="h-12 text-[16px] md:h-8 md:text-sm" />
      )}
    </div>
  );
}
