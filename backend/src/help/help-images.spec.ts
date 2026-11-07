import fs from "fs";
import * as os from "os";
import * as path from "path";
import { imageSize, readBundledImage, readImageBundle } from "./help-images";

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function riff(chunk: string, body: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(12 + body.length, 4);
  head.write("WEBP", 8, "latin1");
  head.write(chunk, 12, "latin1");
  head.writeUInt32LE(body.length, 16);
  return Buffer.concat([head, body]);
}

/** Lossless: signature, then width-1 and height-1 in 14 bits each. */
function vp8l(width: number, height: number): Buffer {
  const body = Buffer.alloc(10);
  body[0] = 0x2f;
  body.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return riff("VP8L", body);
}

/** Lossy: a key frame tag, the start code, then the two dimensions. */
function vp8(width: number, height: number): Buffer {
  const body = Buffer.alloc(12);
  Buffer.from([0x9d, 0x01, 0x2a]).copy(body, 3);
  body.writeUInt16LE(width, 6);
  body.writeUInt16LE(height, 8);
  return riff("VP8 ", body);
}

/** Extended: flags, then canvas width-1 and height-1 as 24-bit values. */
function vp8x(width: number, height: number): Buffer {
  const body = Buffer.alloc(10);
  body.writeUIntLE(width - 1, 4, 3);
  body.writeUIntLE(height - 1, 7, 3);
  return riff("VP8X", body);
}

describe("imageSize", () => {
  it.each([
    ["PNG", png(1600, 1000)],
    ["lossless WebP", vp8l(1600, 1000)],
    ["lossy WebP", vp8(1600, 1000)],
    ["extended WebP", vp8x(1600, 1000)],
  ])("reads the size of a %s", (_kind, header) => {
    expect(imageSize(header)).toEqual({ width: 1600, height: 1000 });
  });

  it("reads the largest lossless size a 14-bit field holds", () => {
    expect(imageSize(vp8l(16384, 1))).toEqual({ width: 16384, height: 1 });
  });

  it.each([
    ["an empty buffer", Buffer.alloc(0)],
    ["a truncated PNG", png(10, 10).subarray(0, 20)],
    ["a truncated WebP", vp8l(10, 10).subarray(0, 22)],
    ["a JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(28).fill(0)])],
    ["text", Buffer.from("not a picture, just some text here")],
    ["an unknown WebP chunk", riff("ALPH", Buffer.alloc(12))],
    ["a lossy WebP without its start code", riff("VP8 ", Buffer.alloc(12))],
    ["a lossless WebP without its signature", riff("VP8L", Buffer.alloc(10))],
    ["a PNG of zero width", png(0, 10)],
  ])("is null for %s", (_kind, header) => {
    expect(imageSize(header)).toBeNull();
  });
});

describe("readImageBundle", () => {
  let root: string;
  let images: string;
  const warn = jest.fn();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "help-images-"));
    images = path.join(root, "images");
    fs.mkdirSync(images);
    warn.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keys each picture by its name, with its type and size", () => {
    fs.writeFileSync(path.join(images, "shot.webp"), vp8l(800, 600));
    fs.writeFileSync(path.join(images, "shot.light.webp"), vp8l(800, 601));

    const bundle = readImageBundle(root, warn);

    expect([...bundle.keys()].sort()).toEqual(["shot", "shot.light"]);
    expect(bundle.get("shot")).toEqual({
      file: path.join(images, "shot.webp"),
      contentType: "image/webp",
      width: 800,
      height: 600,
      revision: expect.stringMatching(/^[0-9a-z]+-[0-9a-z]+$/),
    });
    expect(bundle.get("shot.light")?.height).toBe(601);
    expect(warn).not.toHaveBeenCalled();
  });

  it("prefers the WebP and falls back to a PNG of the same name", () => {
    fs.writeFileSync(path.join(images, "both.png"), png(10, 10));
    fs.writeFileSync(path.join(images, "both.webp"), vp8l(20, 20));
    fs.writeFileSync(path.join(images, "only.png"), png(30, 40));

    const bundle = readImageBundle(root, warn);

    expect(bundle.get("both")).toMatchObject({
      contentType: "image/webp",
      width: 20,
    });
    expect(bundle.get("only")).toEqual({
      file: path.join(images, "only.png"),
      contentType: "image/png",
      width: 30,
      height: 40,
      revision: expect.any(String),
    });
  });

  it("gives a picture a new revision when its file changes", () => {
    const file = path.join(images, "shot.png");
    fs.writeFileSync(file, png(10, 10));
    fs.utimesSync(file, 1_000_000, 1_000_000);
    const before = readImageBundle(root, warn).get("shot")?.revision;

    fs.writeFileSync(file, Buffer.concat([png(10, 10), Buffer.alloc(8)]));
    fs.utimesSync(file, 1_000_000, 1_000_000);
    const resized = readImageBundle(root, warn).get("shot")?.revision;
    fs.utimesSync(file, 2_000_000, 2_000_000);
    const touched = readImageBundle(root, warn).get("shot")?.revision;

    expect(new Set([before, resized, touched]).size).toBe(3);
    expect(readImageBundle(root, warn).get("shot")?.revision).toBe(touched);
  });

  it("falls back to the PNG when the WebP of the same name is unreadable", () => {
    fs.writeFileSync(path.join(images, "both.webp"), "not a webp");
    fs.writeFileSync(path.join(images, "both.png"), png(10, 12));

    const bundle = readImageBundle(root, warn);

    expect(bundle.get("both")).toMatchObject({
      contentType: "image/png",
      height: 12,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("both.webp"));
  });

  it("skips any file whose name is not a picture's", () => {
    for (const name of [
      "Upper.png",
      "under_score.webp",
      "shot.jpg",
      "shot.dark.png",
      "shot.light.light.png",
      ".hidden.png",
      "shot.png.bak",
    ]) {
      fs.writeFileSync(path.join(images, name), png(1, 1));
    }
    fs.mkdirSync(path.join(images, "nested.png"));

    expect(readImageBundle(root, warn).size).toBe(0);
  });

  it("leaves out, with a warning, a picture whose size cannot be read", () => {
    fs.writeFileSync(path.join(images, "broken.webp"), "not a webp");
    fs.writeFileSync(path.join(images, "fine.png"), png(5, 5));

    const bundle = readImageBundle(root, warn);

    expect([...bundle.keys()]).toEqual(["fine"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken.webp"));
  });

  it("is empty, without a warning, when there is no images directory", () => {
    fs.rmSync(images, { recursive: true });

    expect(readImageBundle(root, warn).size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads only the header of each picture while listing", () => {
    fs.writeFileSync(
      path.join(images, "big.png"),
      Buffer.concat([png(1, 1), Buffer.alloc(100_000)]),
    );
    const read = jest.spyOn(fs, "readFileSync");
    const readSync = jest.spyOn(fs, "readSync");

    readImageBundle(root, warn);

    expect(read).not.toHaveBeenCalled();
    expect(readSync).toHaveBeenCalledTimes(1);
    expect((readSync.mock.calls[0] as unknown[])[3]).toBe(32);
  });

  it("reads a listed picture's bytes", async () => {
    const bytes = vp8l(3, 3);
    fs.writeFileSync(path.join(images, "shot.webp"), bytes);
    const entry = readImageBundle(root, warn).get("shot");
    if (!entry) {
      throw new Error("shot.webp was not listed");
    }

    await expect(readBundledImage(entry)).resolves.toEqual({
      data: bytes,
      revision: entry.revision,
    });
  });

  it("reads the revision of the file as it is now, not as it was listed", async () => {
    const file = path.join(images, "shot.png");
    fs.writeFileSync(file, png(3, 3));
    const entry = readImageBundle(root, warn).get("shot");
    if (!entry) {
      throw new Error("shot.png was not listed");
    }
    const retaken = Buffer.concat([png(3, 3), Buffer.alloc(4)]);
    fs.writeFileSync(file, retaken);

    const read = await readBundledImage(entry);

    expect(read.data).toEqual(retaken);
    expect(read.revision).not.toBe(entry.revision);
  });
});
