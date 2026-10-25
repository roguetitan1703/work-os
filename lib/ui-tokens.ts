// Shared look tokens: one type scale, row heights, icon size and stroke, radii. The sidebar, the account menu and every
// menu use these; Settings, tables and page headers should too, so the app reads as one thing. The numbers also live in
// app/globals.css (--row-nav, --row-menu, --row-table, --icon-size, --icon-stroke); the Tailwind classes are here.
// Feel (taken from how the Claude app is laid out, not its brand): 15px labels, 13px muted section labels, 24px page
// titles, even 36px rows, quiet 18px thin-stroke icons, a soft filled pill for the active item, no coloured bars.

/** lucide props for every icon in nav, menus and rows. */
export const ICON = { size: 18, strokeWidth: 1.6 } as const;

export const ui = {
  /** A nav or menu row: 36px high, 15px text, 12px between icon and label. */
  row: 'flex w-full items-center gap-3 h-9 px-2.5 rounded-lg text-[15px] leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
  rowOn: 'bg-muted font-medium text-foreground',
  rowOff: 'text-foreground/80 hover:bg-muted/60 hover:text-foreground',
  /** The only filled row (New task). */
  rowPrimary: 'bg-foreground text-background hover:bg-foreground/90',
  /** A muted section label ("Recent"). */
  sectionLabel: 'text-[13px] font-medium text-muted-foreground',
  /** Right-aligned shortcut hint. */
  kbd: 'ml-auto text-[11px] font-mono text-muted-foreground',
  /** A popover or menu panel. */
  panel: 'rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none',
  divider: 'my-1.5 h-px bg-border/70',
  pageTitle: 'text-2xl font-semibold tracking-tight text-foreground',
  tableHead: 'text-[13px] font-medium text-muted-foreground',
  tableRow: 'min-h-11 border-t border-border/60',
  /** Count badge in an expanded nav row. */
  badge: 'ml-auto text-xs rounded-full px-1.5 py-0.5 font-medium',
} as const;
