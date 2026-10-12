'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, SESSION_DAYS, checkPassword, createSessionValue, isDev, uiAuthConfigured } from '@/lib/auth';

function safeNext(next: FormDataEntryValue | null): string {
  const s = typeof next === 'string' ? next : '';
  return s.startsWith('/') && !s.startsWith('//') ? s : '/today';
}

export async function loginAction(formData: FormData): Promise<void> {
  const next = safeNext(formData.get('next'));
  if (!uiAuthConfigured()) redirect('/login?error=config');

  const ok = await checkPassword(String(formData.get('password') ?? ''));
  if (!ok) {
    await new Promise(r => setTimeout(r, 600)); // slow down guessing
    redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }

  (await cookies()).set(SESSION_COOKIE, await createSessionValue(), {
    httpOnly: true,
    secure: !isDev(),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });
  redirect(next);
}
