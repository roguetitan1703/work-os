// Claude usage shares as text (Claude › Usage, docs/launcher.md "Usage"). No imports: usable anywhere.

/** 0.572 → "57.2%"; a share above 0 and below 0.1% → "<0.1%". */
export function formatShare(x: number): string {
  if (!(x > 0)) return '0%';
  if (x < 0.001) return '<0.1%';
  return `${Math.round(x * 1000) / 10}%`;
}
