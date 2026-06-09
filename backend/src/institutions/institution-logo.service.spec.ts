import { InstitutionLogoService } from "./institution-logo.service";

describe("InstitutionLogoService", () => {
  let service: InstitutionLogoService;
  const originalFetch = global.fetch;

  beforeEach(() => {
    service = new InstitutionLogoService();
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const mockResponse = (opts: {
    ok?: boolean;
    status?: number;
    contentType?: string | null;
    body?: Uint8Array;
  }) => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (_k: string) => opts.contentType ?? null },
    arrayBuffer: async () => (opts.body ?? new Uint8Array([1, 2, 3])).buffer,
  });

  describe("buildFaviconUrl()", () => {
    it("builds a gstatic faviconV2 URL with the encoded website at 256px", () => {
      const url = service.buildFaviconUrl("https://www.td.com");
      expect(url).toContain("https://t2.gstatic.com/faviconV2");
      expect(url).toContain("size=256");
      expect(url).toContain(`url=${encodeURIComponent("https://www.td.com")}`);
    });
  });

  describe("fetchFavicon()", () => {
    it("returns image bytes and normalised content-type on success", async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          mockResponse({ contentType: "image/png; charset=binary" }),
        ) as any;

      const result = await service.fetchFavicon("https://td.com");

      expect(result).not.toBeNull();
      expect(result!.contentType).toBe("image/png");
      expect(Buffer.isBuffer(result!.data)).toBe(true);
      expect(result!.data.length).toBe(3);
    });

    it("returns null when the response is not ok", async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockResponse({ ok: false, status: 404 })) as any;

      expect(await service.fetchFavicon("https://td.com")).toBeNull();
    });

    it("returns null when the content-type is not an image", async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockResponse({ contentType: "text/html" })) as any;

      expect(await service.fetchFavicon("https://td.com")).toBeNull();
    });

    it("returns null when the payload is empty", async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          mockResponse({ contentType: "image/png", body: new Uint8Array([]) }),
        ) as any;

      expect(await service.fetchFavicon("https://td.com")).toBeNull();
    });

    it("returns null when the payload exceeds the size cap", async () => {
      const huge = new Uint8Array(513 * 1024);
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          mockResponse({ contentType: "image/png", body: huge }),
        ) as any;

      expect(await service.fetchFavicon("https://td.com")).toBeNull();
    });

    it("returns null when fetch throws (network error / abort)", async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error("network down")) as any;

      expect(await service.fetchFavicon("https://td.com")).toBeNull();
    });
  });
});
