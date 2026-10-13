import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/** Renders a note body: GitHub-flavoured markdown (tables, task lists, strikethrough), page typography. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none',
        'prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-lg prose-h2:mt-6 prose-h3:text-base',
        'prose-a:text-blue-600 dark:prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline',
        'prose-code:before:content-none prose-code:after:content-none prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded',
        'prose-pre:bg-muted prose-pre:text-foreground prose-li:my-0.5 prose-table:text-sm',
        '[&_input[type=checkbox]]:mr-1.5 [&_li:has(>input[type=checkbox])]:list-none [&_ul:has(>li>input[type=checkbox])]:pl-1',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
          input: ({ node: _n, type, checked }) =>
            type === 'checkbox' ? <input type="checkbox" checked={!!checked} readOnly disabled suppressHydrationWarning /> : null,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
