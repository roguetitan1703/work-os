import { ImageResponse } from 'next/og';

// App icons for the PWA manifest: /icons/192, /icons/512, /icons/maskable-512.
// Maskable keeps the mark inside the 80% safe zone.

export const dynamic = 'force-static';
export function generateStaticParams() {
  return [{ size: '192' }, { size: '512' }, { size: 'maskable-512' }, { size: '180' }];
}

export async function GET(_: Request, { params }: { params: Promise<{ size: string }> }) {
  const { size } = await params;
  const maskable = size.startsWith('maskable');
  const px = Number(size.replace('maskable-', '')) || 512;
  const mark = Math.round(px * (maskable ? 0.46 : 0.58));
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#111111', borderRadius: maskable ? 0 : Math.round(px * 0.22) }}>
        <svg width={mark} height={mark} viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9.5" stroke="#ffffff" strokeOpacity={0.35} />
          <path d="M7.5 12.5l3 3 6-7" />
        </svg>
      </div>
    ),
    { width: px, height: px },
  );
}
