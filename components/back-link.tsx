'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { hasInAppPrev } from './nav-tracker';

/** Back to the page you came from; with no earlier in-app page, to `href` (the parent). */
export function BackLink({ href, className, children, ...rest }: { href: string; className?: string; children: React.ReactNode; 'aria-label'?: string }) {
  const router = useRouter();
  return (
    <Link
      href={href}
      className={className}
      data-back
      onClick={e => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        if (hasInAppPrev()) router.back();
        else router.push(href);
      }}
      {...rest}
    >
      {children}
    </Link>
  );
}
