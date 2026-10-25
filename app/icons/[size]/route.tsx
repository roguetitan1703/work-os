import fs from 'node:fs';
import path from 'node:path';

// App icons for the PWA manifest and Apple touch icon: /icons/192, /icons/512, /icons/maskable-512, /icons/180.
// The Delpat D with the Work OS check badge, drawn once into assets/brand/ (maskable keeps the mark inside the 80%
// safe zone). app/favicon.ico is the same mark.

export const dynamic = 'force-static';
const SIZES = ['192', '512', 'maskable-512', '180'];
export function generateStaticParams() {
  return SIZES.map(size => ({ size }));
}

export async function GET(_: Request, { params }: { params: Promise<{ size: string }> }) {
  const { size } = await params;
  if (!SIZES.includes(size)) return new Response('Not found', { status: 404 });
  const png = fs.readFileSync(path.join(process.cwd(), 'assets', 'brand', `app-${size}.png`));
  return new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
}
