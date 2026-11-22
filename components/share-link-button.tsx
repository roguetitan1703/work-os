'use client';

import { Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { IconButton } from '@/components/ui/icon-button';

/**
 * Share a page's link: the system share sheet where the browser has one (phones, the installed app), else the link goes
 * to the clipboard with a toast. Same size as the other icon buttons on a page's top bar. Changes no access.
 */
export function ShareLinkButton({ path, title }: { path: string; title: string }) {
  async function share() {
    const url = new URL(path, window.location.origin).toString();
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url });
        return;
      } catch (e) {
        // Closing the share sheet is not an error; anything else (NotAllowedError, ...) falls back to the clipboard.
        if ((e as { name?: string })?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      toast.error('Could not copy the link');
    }
  }
  return (
    <IconButton label="Share link" onClick={share} data-share-link className="md:h-8 md:w-8 rounded-xl md:rounded-md">
      <Share2 className="w-4 h-4" />
    </IconButton>
  );
}
