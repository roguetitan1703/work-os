'use client';

import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useApp } from '../app-context';

/** Bell with unread badge, for phone headers. */
export function BellButton() {
  const { unread } = useApp();
  return (
    <Link
      href="/notifications"
      aria-label={unread ? `${unread} new notifications` : 'Notifications'}
      className="relative w-11 h-11 flex items-center justify-center rounded-full active:bg-muted"
    >
      <Bell className="w-[22px] h-[22px]" />
      {unread > 0 && (
        <span className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[11px] font-semibold leading-[18px] text-center">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}
