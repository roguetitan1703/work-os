'use client';

import { useActionState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { savePlanResetAction, type UsageResetResult } from './usage-actions';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** When the plan's week starts over: weekday, time and the timezone that time is in. */
export function UsageResetForm({ weekday, time, tz }: { weekday: number; time: string; tz: string }) {
  const [state, action, pending] = useActionState<UsageResetResult | null, FormData>(savePlanResetAction, null);
  const zones = useMemo(() => {
    let all: string[] = [];
    try {
      all = Intl.supportedValuesOf('timeZone');
    } catch {}
    return all.includes(tz) ? all : [tz, ...all];
  }, [tz]);
  return (
    <form action={action} className="space-y-3" data-usage-reset>
      <Field label="Weekday">{id => (
        <Select id={id} name="weekday" defaultValue={String(weekday)} className="h-11 md:h-9 rounded-control">
          {WEEKDAYS.map((w, i) => (
            <option key={w} value={String(i)}>{w}</option>
          ))}
        </Select>
      )}</Field>
      <Field label="Time">{id => <Input id={id} name="time" type="time" defaultValue={time} className="h-11 md:h-9 rounded-control" />}</Field>
      <Field label="Timezone">{id => (
        <Select id={id} name="tz" defaultValue={tz} className="h-11 md:h-9 rounded-control">
          {zones.map(z => (
            <option key={z} value={z}>{z}</option>
          ))}
        </Select>
      )}</Field>
      <Button type="submit" size="touch" disabled={pending}>Save</Button>
      {state && !state.ok && <p className="text-meta text-destructive" data-usage-reset-error>{state.error}</p>}
      {state?.ok && <p className="text-meta text-muted-foreground">Saved.</p>}
    </form>
  );
}
