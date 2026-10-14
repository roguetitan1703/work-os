'use client';

import { useState } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Read-only text with a copy button. `secret` masks part of the text until revealed. */
export function CopyBox({
  text,
  secret,
  multiline = false,
  className,
}: {
  text: string;
  /** substring to mask until "reveal" is clicked */
  secret?: string;
  multiline?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(false);
  const display = secret && !shown ? text.replace(secret, '•'.repeat(Math.min(secret.length, 24))) : text;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div className={cn('group relative min-w-0 max-w-full rounded-lg border border-border bg-muted/40', className)}>
      <pre
        className={cn(
          'px-3 py-2.5 pr-20 max-md:pr-28 max-md:min-h-14 text-xs font-mono text-foreground',
          multiline ? 'whitespace-pre-wrap break-words max-h-80 overflow-y-auto' : 'whitespace-nowrap overflow-x-auto',
        )}
      >
        {display}
      </pre>
      <div className="absolute top-1.5 right-1.5 max-md:top-1 max-md:right-1 flex gap-1">
        {secret && (
          <button
            onClick={() => setShown(s => !s)}
            className="p-1.5 max-md:h-11 max-md:w-11 inline-flex items-center justify-center rounded-md bg-background border border-border text-muted-foreground hover:text-foreground"
            title={shown ? 'Hide' : 'Reveal'}
          >
            {shown ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        )}
        <button
          onClick={copy}
          className="p-1.5 max-md:h-11 max-md:w-11 inline-flex items-center justify-center rounded-md bg-background border border-border text-muted-foreground hover:text-foreground"
          title="Copy"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}
