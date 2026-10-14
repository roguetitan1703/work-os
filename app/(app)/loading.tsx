// Shown instantly on every navigation while the server renders the page, so a tap
// always gets an immediate response. Kept generic (title + list) because it is shown for
// every page, not just Today. Phone and desktop shapes differ.

function Bar({ className }: { className: string }) {
  return <div className={`rounded-lg bg-muted animate-pulse ${className}`} />;
}

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      {/* Phone */}
      <div className="md:hidden">
        <div className="pt-1 pb-3">
          <Bar className="h-8 w-36" />
          <Bar className="h-4 w-48 mt-2" />
        </div>
        {[3, 2, 4].map((rows, s) => (
          <div key={s} className="mt-5">
            <Bar className="h-3.5 w-24 mb-2" />
            <div className="rounded-2xl border border-border/70 divide-y divide-border/60 overflow-hidden">
              {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-3.5">
                  <div className="w-[22px] h-[22px] rounded-full border-2 border-muted shrink-0" />
                  <div className="flex-1">
                    <Bar className="h-4 w-4/5" />
                    <Bar className="h-3 w-2/5 mt-2" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {/* Desktop */}
      <div className="hidden md:block max-w-5xl space-y-4">
        <Bar className="h-8 w-48" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Bar key={i} className="h-9" />
        ))}
      </div>
    </div>
  );
}
