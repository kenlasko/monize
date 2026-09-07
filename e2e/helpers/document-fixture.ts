import { deflateSync } from 'node:zlib';

/**
 * A PNG of a skewed document, generated rather than checked in.
 *
 * The end-to-end spec drives the real scanner in a real browser, so it needs a
 * picture with a findable page in it -- and the same recipe the unit fixtures
 * use (`frontend/src/lib/document-scanner/synthetic-document.ts`), so a change
 * that breaks detection fails in both places rather than only in the slow one.
 *
 * Written by hand because the alternative is a binary blob in the repository
 * whose contents nobody can review.
 */

/** The page's corners, matching the unit fixture's default. */
const QUAD: { x: number; y: number }[] = [
  { x: 140, y: 90 },
  { x: 620, y: 150 },
  { x: 580, y: 640 },
  { x: 100, y: 560 },
];

const WIDTH = 720;
const HEIGHT = 720;
const PAPER = 240;
const BACKGROUND = 40;
const INK = 30;
/** How far printed lines stay clear of the page edge, so the outline survives. */
const TEXT_MARGIN = 24;

function insideQuad(x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = QUAD[i];
    const b = QUAD[(i + 1) % 4];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross === 0) continue;
    const current = Math.sign(cross);
    if (sign === 0) sign = current;
    else if (current !== sign) return false;
  }
  return true;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** Render the fixture as an 8-bit greyscale PNG. */
export function syntheticDocumentPng(): Buffer {
  // One filter byte (0 = none) per row, then one sample per pixel.
  const raw = Buffer.alloc(HEIGHT * (WIDTH + 1));
  for (let y = 0; y < HEIGHT; y++) {
    const rowStart = y * (WIDTH + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < WIDTH; x++) {
      const inside = insideQuad(x, y);
      let value = inside ? PAPER : BACKGROUND;
      if (inside && y % 24 < 3) {
        const clearOfEdge =
          insideQuad(x - TEXT_MARGIN, y) &&
          insideQuad(x + TEXT_MARGIN, y) &&
          insideQuad(x, y - TEXT_MARGIN) &&
          insideQuad(x, y + TEXT_MARGIN);
        if (clearOfEdge) value = INK;
      }
      raw[rowStart + 1 + x] = value;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // colour type: greyscale
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
