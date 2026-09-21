import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

/*
 * Serves files uploaded from the admin (DATA_DIR/uploads). They cannot live in /public because
 * Next.js only serves public files that existed at build time, and DATA_DIR is the persistent disk.
 */
// .pdf: safety data sheets (uploads/sds), checked for the %PDF- signature when they are stored
const TYPES: Record<string, string> = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.avif': 'image/avif', '.pdf': 'application/pdf' };

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  const root = path.resolve(process.env.DATA_DIR || './data', 'uploads');
  const file = path.resolve(root, ...segments);
  const type = TYPES[path.extname(file).toLowerCase()];
  // path traversal guard + extension allow-list
  if (!type || !file.startsWith(root + path.sep)) return new NextResponse('Not found', { status: 404 });

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        'Content-Type': type, 'Content-Length': String(info.size), 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
        // a data sheet opens in the browser's own viewer; it is the manufacturer's document, not a page of ours to index
        ...(type === 'application/pdf' && { 'Content-Disposition': 'inline', 'X-Robots-Tag': 'noindex' }),
      },
    });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
