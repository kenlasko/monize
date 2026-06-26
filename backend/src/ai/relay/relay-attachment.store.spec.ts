import { BadRequestException } from "@nestjs/common";
import { RelayAttachmentStore } from "./relay-attachment.store";

const USER = "user-1";
const OTHER = "user-2";

// A valid 1x1 PNG so magic-byte validation passes.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const CSV_BASE64 = Buffer.from("a,b\n1,2\n").toString("base64");

const png = (filename = "img.png") => ({
  kind: "image" as const,
  mediaType: "image/png",
  filename,
  data: PNG_BASE64,
});

describe("RelayAttachmentStore", () => {
  let store: RelayAttachmentStore;

  beforeEach(() => {
    jest.useFakeTimers();
    store = new RelayAttachmentStore();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns an empty list and stores nothing for no attachments", () => {
    expect(store.store(USER, [])).toEqual([]);
  });

  it("stores an attachment and returns a ref with a resource uri", () => {
    const [ref] = store.store(USER, [png("chart.png")]);
    expect(ref.filename).toBe("chart.png");
    expect(ref.kind).toBe("image");
    expect(ref.mediaType).toBe("image/png");
    expect(ref.uri).toBe(`monize-attachment://${ref.id}`);

    const stored = store.get(USER, ref.id);
    expect(stored?.data.length).toBeGreaterThan(0);
    expect(stored?.data.toString("base64")).toBe(PNG_BASE64);
  });

  it("decodes text attachments to readable bytes", () => {
    const [ref] = store.store(USER, [
      {
        kind: "text",
        mediaType: "text/csv",
        filename: "rows.csv",
        data: CSV_BASE64,
      },
    ]);
    expect(store.get(USER, ref.id)?.data.toString("utf-8")).toBe("a,b\n1,2\n");
  });

  it("isolates attachments between users", () => {
    const [ref] = store.store(USER, [png()]);
    // Another user cannot resolve this id, even though it is globally unique.
    expect(store.get(OTHER, ref.id)).toBeUndefined();
    expect(store.get(USER, ref.id)).toBeDefined();
  });

  it("returns undefined for an unknown id", () => {
    expect(store.get(USER, "missing")).toBeUndefined();
  });

  it("releases attachments for a prompt", () => {
    const [a, b] = store.store(USER, [png("a.png"), png("b.png")]);
    store.releaseForPrompt(USER, [a.id]);
    expect(store.get(USER, a.id)).toBeUndefined();
    expect(store.get(USER, b.id)).toBeDefined();
  });

  it("prunes an attachment after its TTL", () => {
    const [ref] = store.store(USER, [png()]);
    // Past the 20-minute TTL.
    jest.advanceTimersByTime(20 * 60 * 1000 + 1);
    expect(store.get(USER, ref.id)).toBeUndefined();
  });

  it("evicts the oldest attachment past the per-user cap", () => {
    const ids: string[] = [];
    // Store 51 attachments (cap is 50), advancing time so each is strictly
    // newer than the last and the eviction order is deterministic.
    for (let i = 0; i < 51; i++) {
      jest.advanceTimersByTime(1000);
      ids.push(store.store(USER, [png(`f${i}.png`)])[0].id);
    }
    // The very first (oldest) was evicted; the newest survives.
    expect(store.get(USER, ids[0])).toBeUndefined();
    expect(store.get(USER, ids[50])).toBeDefined();
  });

  describe("validation", () => {
    it("rejects a kind/media-type mismatch", () => {
      expect(() => store.store(USER, [{ ...png(), kind: "pdf" }])).toThrow(
        BadRequestException,
      );
    });

    it("rejects bytes that do not match the declared type (magic bytes)", () => {
      expect(() =>
        store.store(USER, [
          { ...png(), data: Buffer.from("not a png").toString("base64") },
        ]),
      ).toThrow(BadRequestException);
    });

    it("rejects an attachment over the per-file size limit", () => {
      // A PNG header followed by >5 MB of padding.
      const header = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const big = Buffer.concat([header, Buffer.alloc(5 * 1024 * 1024 + 1)]);
      expect(() =>
        store.store(USER, [{ ...png(), data: big.toString("base64") }]),
      ).toThrow(BadRequestException);
    });
  });
});
