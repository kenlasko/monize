import * as fs from "fs";
import * as path from "path";

/**
 * A screenshot of the user guide as the bundle holds it: one file in the
 * bundle's `images/` directory. `file` comes from listing that directory when
 * the bundle loads, never from a request.
 */
export interface HelpImageEntry {
  file: string;
  contentType: "image/webp" | "image/png";
  width: number;
  height: number;
  /** The file's size and modification time: changes whenever its bytes do. */
  revision: string;
}

/**
 * A file the bundle serves: `<name>.webp` (the image, converted at build time)
 * or `<name>.png` (the source tree and the dev stack's mount). `name` is the
 * picture's name, `.light` included for the light twin.
 */
const IMAGE_FILE_RE = /^([a-z0-9-]+(?:\.light)?)\.(webp|png)$/;

/** How much of a file `imageSize` needs: a WebP `VP8X` header ends at byte 30. */
const HEADER_BYTES = 32;

/**
 * Width and height from the start of a PNG (`IHDR`) or a WebP (`VP8 `, `VP8L`
 * or `VP8X`), so a picture reserves its box before it loads. `null` for
 * anything else, or a header too short to hold its size.
 */
export function imageSize(
  header: Buffer,
): { width: number; height: number } | null {
  if (
    header.length >= 24 &&
    header.toString("latin1", 1, 4) === "PNG" &&
    header.toString("latin1", 12, 16) === "IHDR"
  ) {
    return sized(header.readUInt32BE(16), header.readUInt32BE(20));
  }
  if (
    header.length < 16 ||
    header.toString("latin1", 0, 4) !== "RIFF" ||
    header.toString("latin1", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const chunk = header.toString("latin1", 12, 16);
  if (chunk === "VP8 " && header.length >= 30) {
    // Lossy: a key frame's start code, then two 14-bit dimensions.
    if (header[23] !== 0x9d || header[24] !== 0x01 || header[25] !== 0x2a) {
      return null;
    }
    return sized(
      header.readUInt16LE(26) & 0x3fff,
      header.readUInt16LE(28) & 0x3fff,
    );
  }
  if (chunk === "VP8L" && header.length >= 25) {
    // Lossless: a signature byte, then width-1 and height-1 in 14 bits each.
    if (header[20] !== 0x2f) {
      return null;
    }
    const bits = header.readUInt32LE(21);
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X" && header.length >= 30) {
    // Extended: canvas width-1 and height-1 as 24-bit values.
    return sized(header.readUIntLE(24, 3) + 1, header.readUIntLE(27, 3) + 1);
  }
  return null;
}

function sized(
  width: number,
  height: number,
): { width: number; height: number } | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Lists the bundle's `images/` directory once and returns every picture by
 * name. A WebP wins over a PNG of the same name; a PNG is the fallback, which
 * is what the source tree and the dev stack's mount hold. A file whose header
 * does not parse is reported through `warn` and passed over for the next one;
 * a picture with none readable is left out, so the page shows its caption
 * instead. No directory is an empty bundle, not an error.
 */
export function readImageBundle(
  directory: string,
  warn: (message: string) => void,
): Map<string, HelpImageEntry> {
  const folder = path.join(directory, "images");
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return new Map();
  }

  // Each picture's files, the WebP before the PNG.
  const candidates = new Map<string, string[]>();
  for (const fileName of [...names].sort()) {
    const match = IMAGE_FILE_RE.exec(fileName);
    if (!match) {
      continue;
    }
    const [, name, extension] = match;
    const files = candidates.get(name) ?? [];
    candidates.set(
      name,
      extension === "webp" ? [fileName, ...files] : [...files, fileName],
    );
  }

  const images = new Map<string, HelpImageEntry>();
  for (const [name, fileNames] of candidates) {
    for (const fileName of fileNames) {
      const file = path.join(folder, fileName);
      const header = readHeader(file);
      if (!header) {
        warn(`Help image ${fileName} has no readable size; it is left out`);
        continue;
      }
      images.set(name, {
        file,
        contentType: fileName.endsWith(".webp") ? "image/webp" : "image/png",
        ...header,
      });
      break;
    }
  }
  return images;
}

/**
 * The size in a file's header, and its revision; `file` is a directory entry
 * just listed.
 */
function readHeader(
  file: string,
): { width: number; height: number; revision: string } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const header = Buffer.alloc(HEADER_BYTES);
    const read = fs.readSync(fd, header, 0, HEADER_BYTES, 0);
    const size = imageSize(header.subarray(0, read));
    if (!size) {
      return null;
    }
    return { ...size, revision: fileRevision(fs.fstatSync(fd)) };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

/** A file's revision: its size and modification time, which change with its bytes. */
function fileRevision(stat: fs.Stats): string {
  return `${stat.size.toString(36)}-${Math.trunc(stat.mtimeMs).toString(36)}`;
}

/**
 * The bytes of a bundled picture and the revision of the file they came from,
 * which can differ from the entry's when the file changed after the listing
 * (a screenshot retaken under the dev stack's mount). `entry` is one
 * `readImageBundle` returned.
 */
export async function readBundledImage(
  entry: HelpImageEntry,
): Promise<{ data: Buffer; revision: string }> {
  const handle = await fs.promises.open(entry.file, "r");
  try {
    const stat = await handle.stat();
    const data = await handle.readFile();
    return { data, revision: fileRevision(stat) };
  } finally {
    await handle.close();
  }
}
