'use server';

import { redirect } from 'next/navigation';
import { SafeError } from '@/lib/auth';
import { getCaller } from '@/lib/caller';
import { acceptAsNewUser, acceptAsSignedIn } from '@/lib/members';

// The accept-invitation page's forms (public: proxy.ts lets /accept-invitation/<id> through). Every check is in
// lib/members.ts: the secret in the link, the invitation still pending and unexpired, the address.

const back = (id: string, t: string, msg: string) => `/accept-invitation/${encodeURIComponent(id)}?t=${encodeURIComponent(t)}&error=${encodeURIComponent(msg)}`;
const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

export async function acceptNewAction(form: FormData): Promise<void> {
  const id = str(form.get('id')).slice(0, 64);
  const t = str(form.get('t')).slice(0, 100);
  const password = str(form.get('password'));
  if (password !== str(form.get('again'))) redirect(back(id, t, 'The two passwords do not match.'));
  try {
    await acceptAsNewUser(id, t, str(form.get('name')), password);
  } catch (e) {
    if (!(e instanceof SafeError)) console.error('accept invitation failed', e);
    redirect(back(id, t, e instanceof SafeError ? e.message : 'Something went wrong. Try again.'));
  }
  redirect('/today?welcome=1');
}

export async function acceptSignedInAction(form: FormData): Promise<void> {
  const id = str(form.get('id')).slice(0, 64);
  const t = str(form.get('t')).slice(0, 100);
  try {
    await acceptAsSignedIn(id, t, await getCaller());
  } catch (e) {
    if (!(e instanceof SafeError)) console.error('accept invitation failed', e);
    redirect(back(id, t, e instanceof SafeError ? e.message : 'Something went wrong. Try again.'));
  }
  redirect('/today?welcome=1');
}
