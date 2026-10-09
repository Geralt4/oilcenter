import sharp from 'sharp';

// Product photos are raster images: nothing in the shop ever needs to decode an SVG. The image library's SVG
// decoder (librsvg) is where its last memory-safety advisory was (GHSA-wq5f-xc86-pv6w), so the format is refused
// outright — an uploaded SVG then fails like any other unreadable photo, with the same message to the owner.
sharp.block({ operation: ['VipsForeignLoadSvg'] });

/*
 * Product-photo normaliser.
 *
 * Shop photos arrive in every shape: pure-white studio shots, light-grey backdrops with a
 * reflection, phone screenshots with a hairline border, and photos taken on the shop counter.
 * Everything leaves here as a 1000×1000 WebP so the product grid reads as one system:
 *   studio shot → backdrop pushed to pure white, trimmed, centred with even padding
 *   scene photo → square crop biased towards the counter, where the bottles stand
 */

const CANVAS = 1000;
const INNER = 860;

export type NormalizeOptions = {
  /** fraction of the height to cut from the top / bottom first (phone status bars, browser chrome) */
  cropTopPct?: number;
  cropBottomPct?: number;
  /** force a mode instead of auto-detecting */
  mode?: 'studio' | 'scene';
};

export type NormalizeResult = { data: Buffer; kind: 'studio' | 'studio-levelled' | 'scene'; width: number; height: number };

type Region = { left: number; top: number; width: number; height: number };

async function regionStats(input: Buffer, region: Region) {
  // sharp's stats() always reads the ORIGINAL input, so the crop has to be materialised first
  const crop = await sharp(input).extract(region).png().toBuffer();
  const { channels } = await sharp(crop).stats();
  const rgb = channels.slice(0, 3);
  const means = rgb.map((c) => c.mean);
  return {
    mean: means.reduce((a, b) => a + b, 0) / means.length,
    std: Math.max(...rgb.map((c) => c.stdev)),
    chroma: Math.max(...means) - Math.min(...means),
  };
}

export async function normalizeProductPhoto(input: Buffer | string, opts: NormalizeOptions = {}): Promise<NormalizeResult> {
  const meta = await sharp(input).rotate().metadata();
  // after .rotate() the autoOrient dimensions are what we will actually get
  let w = meta.autoOrient?.width ?? meta.width ?? 0;
  let h = meta.autoOrient?.height ?? meta.height ?? 0;
  if (!w || !h) throw new Error('Μη έγκυρη εικόνα');

  let pipeline = sharp(input).rotate().flatten({ background: '#ffffff' });
  const cutTop = Math.round(h * (opts.cropTopPct ?? 0));
  const cutBottom = Math.round(h * (opts.cropBottomPct ?? 0));
  // Screenshot crops often carry a 1–2px hairline on an edge; shave it so it can't poison the analysis or the trim.
  const shave = Math.max(3, Math.round(Math.min(w, h) * 0.005));
  const region: Region = { left: shave, top: cutTop + shave, width: w - shave * 2, height: h - cutTop - cutBottom - shave * 2 };
  if (region.width < 50 || region.height < 50) throw new Error('Η εικόνα είναι πολύ μικρή');
  pipeline = pipeline.extract(region);
  w = region.width;
  h = region.height;
  let buf = await pipeline.png().toBuffer();

  const s = Math.max(8, Math.round(Math.min(w, h) * 0.035));
  const [tl, tr, bl, br] = await Promise.all([
    regionStats(buf, { left: 0, top: 0, width: s, height: s }),
    regionStats(buf, { left: w - s, top: 0, width: s, height: s }),
    regionStats(buf, { left: 0, top: h - s, width: s, height: s }),
    regionStats(buf, { left: w - s, top: h - s, width: s, height: s }),
  ]);
  const corners = [tl, tr, bl, br];
  // A product that touches the frame mid-side is fine; two dark / busy / coloured CORNERS mean a real scene.
  const badCorners = corners.filter((c) => c.mean < 175 || c.std > 28 || c.chroma > 26).length;
  const isScene = opts.mode ? opts.mode === 'scene' : badCorners >= 2;

  if (isScene) {
    const side = Math.min(w, h);
    // bottles stand on the counter in the lower part of a portrait frame → bias the square downwards
    const top = h > w ? Math.round((h - side) * 0.65) : 0;
    const left = w > h ? Math.round((w - side) / 2) : 0;
    const data = await sharp(buf).extract({ left, top, width: side, height: side }).resize(CANVAS, CANVAS, { kernel: 'lanczos3' }).webp({ quality: 84 }).toBuffer();
    return { data, kind: 'scene', width: CANVAS, height: CANVAS };
  }

  // Studio shot: gentle levels stretch anchored on the darker TOP corner
  // (bottom corners usually carry the product's own shadow or reflection).
  const topBg = Math.min(tl.mean, tr.mean);
  const darkest = Math.min(...corners.map((c) => c.mean));
  const anchor = Math.min(topBg, (darkest + topBg) / 2);
  let kind: NormalizeResult['kind'] = 'studio';
  if (anchor < 251) {
    const gain = Math.min(1.22, 255 / Math.max(anchor - 1, 200));
    buf = await sharp(buf).linear(gain, 0).png().toBuffer();
    kind = 'studio-levelled';
  }

  let content = buf;
  try {
    const trimmed = await sharp(buf).trim({ background: '#ffffff', threshold: 14 }).png().toBuffer({ resolveWithObject: true });
    if (trimmed.info.width >= 40 && trimmed.info.height >= 40) content = trimmed.data;
  } catch {
    /* nothing to trim */
  }

  const fitted = await sharp(content).resize(INNER, INNER, { fit: 'inside', kernel: 'lanczos3' }).png().toBuffer({ resolveWithObject: true });
  const data = await sharp({ create: { width: CANVAS, height: CANVAS, channels: 3, background: '#ffffff' } })
    .composite([{ input: fitted.data, left: Math.round((CANVAS - fitted.info.width) / 2), top: Math.round((CANVAS - fitted.info.height) / 2) }])
    .webp({ quality: 86 })
    .toBuffer();
  return { data, kind, width: CANVAS, height: CANVAS };
}

/** Wide photos for the home / about pages: resize only, no background work. */
export async function resizePhoto(input: Buffer | string, width: number, height?: number): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize(width, height, { fit: height ? 'cover' : 'inside', position: 'attention', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}
