import fs from "fs";
import * as os from "os";
import * as path from "path";
import { Logger } from "@nestjs/common";
import { HelpService } from "./help.service";

/** The first bytes of a lossless WebP of the given size. */
function webp(width: number, height: number): Buffer {
  const header = Buffer.alloc(30);
  header.write("RIFF", 0, "latin1");
  header.write("WEBPVP8L", 8, "latin1");
  header[20] = 0x2f;
  header.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return header;
}

/** The first bytes of a PNG of the given size. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  header.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

const NAV = [
  {
    group: "Getting started",
    pages: [{ slug: "first-page", summary: "The first page." }],
  },
  {
    group: "Core features",
    pages: [{ slug: "second-page", summary: "The second page." }],
  },
];

const INDEX = [
  { u: "/docs/", p: "Landing", h: "", x: "Welcome." },
  { u: "/docs/#intro", p: "Landing", h: "Intro", x: "Hi." },
  { u: "/docs/first-page", p: "First Page", h: "", x: "Lead." },
  { u: "/docs/first-page#alpha", p: "First Page", h: "Alpha", x: "A." },
  { u: "/docs/first-page#beta", p: "First Page", h: "Beta", x: "B." },
  { u: "/docs/first-page#gamma", p: "First Page", h: "Gamma", x: "C." },
  { u: "/docs/second-page", p: "Second Page", h: "", x: "Lead." },
];

const FIRST_PAGE = [
  "# First Page",
  "",
  "Lead.",
  "",
  "## Alpha",
  "",
  "![Alpha in both themes](images/alpha.png)",
  "",
  "![Not taken yet](images/pending.png) and ![Alpha again](images/alpha.png)",
  "",
  "```sh",
  "## not a heading",
  "```",
  "",
  "### Beta",
  "",
  "![Beta in one theme](images/beta.png)",
  "",
  "## Gamma",
  "",
].join("\n");

describe("HelpService", () => {
  let tmpRoot: string;
  let helpDir: string;
  let service: HelpService;

  function writeBundle(): void {
    fs.mkdirSync(helpDir);
    fs.writeFileSync(path.join(helpDir, "nav.json"), JSON.stringify(NAV));
    fs.writeFileSync(
      path.join(helpDir, "search-index.json"),
      JSON.stringify(INDEX),
    );
    fs.writeFileSync(path.join(helpDir, "index.md"), "# Landing\n\n## Intro\n");
    fs.writeFileSync(path.join(helpDir, "first-page.md"), FIRST_PAGE);
    fs.writeFileSync(path.join(helpDir, "second-page.md"), "# Second Page\n");
    // A file beside the bundle that must never be reachable through a slug.
    fs.writeFileSync(path.join(tmpRoot, "secret.md"), "top secret");
    // The pictures: alpha in both themes (the image's WebP), beta in one (a
    // PNG, as the dev stack's mount holds), and files beside them no name
    // may reach.
    const images = path.join(helpDir, "images");
    fs.mkdirSync(images);
    fs.writeFileSync(path.join(images, "alpha.webp"), webp(1600, 1000));
    fs.writeFileSync(path.join(images, "alpha.light.webp"), webp(1600, 1000));
    fs.writeFileSync(path.join(images, "beta.png"), png(800, 450));
    fs.writeFileSync(path.join(helpDir, "secret.webp"), webp(1, 1));
    fs.writeFileSync(path.join(tmpRoot, "secret.png"), png(1, 1));
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "help-"));
    helpDir = path.join(tmpRoot, "help");
    // The service resolves the bundle from process.cwd()/help (its location in
    // the image); point cwd at a temp root to isolate from the real docs.
    jest.spyOn(process, "cwd").mockReturnValue(tmpRoot);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    service = new HelpService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("getManifest", () => {
    it("lists the landing page then every nav page with its group", () => {
      writeBundle();

      expect(service.getManifest()).toEqual({
        version: service.currentVersion,
        available: true,
        pages: [
          { slug: "index", title: "Landing", summary: "", group: "" },
          {
            slug: "first-page",
            title: "First Page",
            summary: "The first page.",
            group: "Getting started",
          },
          {
            slug: "second-page",
            title: "Second Page",
            summary: "The second page.",
            group: "Core features",
          },
        ],
      });
    });

    it("reports unavailable with no pages, and warns once, when the bundle is missing", () => {
      const warn = jest.spyOn(Logger.prototype, "warn");
      // The repository's own website/docs is also a candidate; hide every one.
      jest.spyOn(fs, "existsSync").mockReturnValue(false);

      expect(service.getManifest()).toEqual({
        version: service.currentVersion,
        available: false,
        pages: [],
      });
      service.getManifest();
      expect(service.getPage("first-page")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("reports unavailable when nav.json is not valid JSON", () => {
      fs.mkdirSync(helpDir);
      fs.writeFileSync(path.join(helpDir, "nav.json"), "{not json");

      expect(service.getManifest().available).toBe(false);
    });

    it("loads the bundle once", () => {
      writeBundle();
      const read = jest.spyOn(fs, "readFileSync");

      service.getManifest();
      service.getManifest();

      // nav.json, search-index.json and the three pages, all on the first call
      expect(read).toHaveBeenCalledTimes(5);
    });
  });

  describe("getPage", () => {
    beforeEach(writeBundle);

    it("returns the Markdown as written with its metadata", () => {
      const page = service.getPage("first-page");

      expect(page).toEqual({
        slug: "first-page",
        title: "First Page",
        group: "Getting started",
        markdown: FIRST_PAGE,
        toc: expect.any(Array),
        onlineUrl: "https://www.monize.net/docs/first-page",
        images: expect.any(Object),
      });
    });

    it("builds the toc from the index in order, with depth from the Markdown", () => {
      expect(service.getPage("first-page")?.toc).toEqual([
        { depth: 2, id: "alpha", heading: "Alpha" },
        { depth: 3, id: "beta", heading: "Beta" },
        { depth: 2, id: "gamma", heading: "Gamma" },
      ]);
    });

    it("serves the landing page under the slug index with the site root as its online URL", () => {
      const page = service.getPage("index");

      expect(page).toMatchObject({
        slug: "index",
        title: "Landing",
        group: "",
        onlineUrl: "https://www.monize.net/docs/",
      });
      expect(page?.toc).toEqual([{ depth: 2, id: "intro", heading: "Intro" }]);
    });

    it("gives a page with no sections an empty toc", () => {
      expect(service.getPage("second-page")?.toc).toEqual([]);
    });

    it("falls back to depth 2 when the headings and the index disagree", () => {
      fs.writeFileSync(path.join(helpDir, "first-page.md"), "# First Page\n");
      service = new HelpService();

      expect(service.getPage("first-page")?.toc.map((t) => t.depth)).toEqual([
        2, 2, 2,
      ]);
    });

    it("serves pages from memory once the bundle has loaded", () => {
      service.getManifest();
      const read = jest.spyOn(fs, "readFileSync");

      const first = service.getPage("first-page");
      const second = service.getPage("first-page");

      expect(first).not.toBeNull();
      expect(second).toBe(first);
      expect(read).not.toHaveBeenCalled();
    });

    it("reads only the files nav.json names when the bundle loads", () => {
      const read = jest.spyOn(fs, "readFileSync");

      service.getManifest();

      const files = read.mock.calls.map(([file]) =>
        path.basename(String(file)),
      );
      expect(files.sort()).toEqual([
        "first-page.md",
        "index.md",
        "nav.json",
        "search-index.json",
        "second-page.md",
      ]);
    });

    it("returns null for a page that nav.json lists but whose file is gone", () => {
      fs.rmSync(path.join(helpDir, "second-page.md"));

      expect(service.getPage("second-page")).toBeNull();
    });

    it.each([
      "unknown-page",
      "secret",
      "../secret",
      "..%2Fsecret",
      "%2e%2e%2fsecret",
      "..",
      "../etc/passwd",
      "first-page.md",
      "first-page/../second-page",
      "First-Page",
      "first_page",
      "first-page\0",
      "first-page%00",
      "",
      " ",
    ])("answers null for %j without reading any file", (slug) => {
      service.getManifest();
      const read = jest.spyOn(fs, "readFileSync");
      const exists = jest.spyOn(fs, "existsSync");
      const open = jest.spyOn(fs, "openSync");

      expect(service.getPage(slug)).toBeNull();

      expect(read).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    });

    it("answers null for a non-string slug", () => {
      expect(service.getPage(undefined as unknown as string)).toBeNull();
      expect(
        service.getPage({ toString: () => "first-page" } as never),
      ).toBeNull();
    });
  });
  describe("images", () => {
    beforeEach(writeBundle);

    it("lists each picture a page names in both themes, in page order", () => {
      const images = service.getPage("first-page")?.images;

      // The prefix itself is asserted by "keys each picture's cache..." below.
      const revision = expect.stringContaining(`${service.currentVersion}-`);
      expect(images).toEqual({
        alpha: {
          dark: { name: "alpha", width: 1600, height: 1000, revision },
          light: { name: "alpha.light", width: 1600, height: 1000, revision },
        },
        beta: {
          dark: { name: "beta", width: 800, height: 450, revision },
          light: null,
        },
      });
      expect(Object.keys(images ?? {})).toEqual(["alpha", "beta"]);
    });

    it("leaves out a picture the bundle does not hold", () => {
      expect(service.getPage("first-page")?.images).not.toHaveProperty(
        "pending",
      );
      expect(service.getPage("second-page")?.images).toEqual({});
    });

    it("serves pages with no pictures when the bundle has no images directory", () => {
      fs.rmSync(path.join(helpDir, "images"), { recursive: true });
      service = new HelpService();

      expect(service.getPage("first-page")?.images).toEqual({});
      expect(service.getManifest().available).toBe(true);
    });

    it("serves a picture's bytes with its type, the WebP before any PNG", async () => {
      await expect(service.getImage("alpha")).resolves.toEqual({
        data: webp(1600, 1000),
        contentType: "image/webp",
        revision: service.getPage("first-page")?.images.alpha.dark.revision,
      });
      await expect(service.getImage("alpha.light")).resolves.toMatchObject({
        contentType: "image/webp",
      });
    });

    it("keys each picture's cache on the running version and its own file", () => {
      const images = service.getPage("first-page")?.images;
      const alpha = images?.alpha.dark.revision ?? "";
      const alphaLight = images?.alpha.light?.revision ?? "";

      expect(alpha.startsWith(`${service.currentVersion}-`)).toBe(true);
      // alpha and its twin hold the same bytes, so only their mtimes may agree;
      // beta is a different file of a different size.
      expect(images?.beta.dark.revision).not.toBe(alpha);
      expect(alphaLight.startsWith(`${service.currentVersion}-`)).toBe(true);
    });

    it("falls back to the PNG when there is no WebP", async () => {
      await expect(service.getImage("beta")).resolves.toMatchObject({
        data: png(800, 450),
        contentType: "image/png",
      });
    });

    it("reads the file the listing found, and only once it is asked for", async () => {
      service.getManifest();
      const open = jest.spyOn(fs.promises, "open");

      await service.getImage("beta");

      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith(
        path.join(helpDir, "images", "beta.png"),
        "r",
      );
    });

    it("stops matching the page's key once the file has changed", async () => {
      const advertised =
        service.getPage("first-page")?.images.beta.dark.revision;
      fs.writeFileSync(
        path.join(helpDir, "images", "beta.png"),
        Buffer.concat([png(800, 450), Buffer.alloc(16)]),
      );

      const image = await service.getImage("beta");

      expect(image?.revision?.startsWith(`${service.currentVersion}-`)).toBe(
        true,
      );
      expect(image?.revision).not.toBe(advertised);
    });

    it("answers null when a listed picture's file has gone", async () => {
      service.getManifest();
      fs.rmSync(path.join(helpDir, "images", "beta.png"));

      await expect(service.getImage("beta")).resolves.toBeNull();
    });

    it.each([
      "pending",
      "beta.light",
      "secret",
      "../secret",
      "../../secret",
      "..%2Fsecret",
      "%2e%2e%2fsecret",
      "..",
      ".",
      "alpha.webp",
      "alpha.png",
      "alpha.light.webp",
      "alpha.light.light",
      "alpha.dark",
      "images/alpha",
      "Alpha",
      "alpha\0",
      "alpha%00",
      "",
      " ",
    ])("answers null for %j without touching the filesystem", async (name) => {
      service.getManifest();
      const reads = [
        jest.spyOn(fs, "readFileSync"),
        jest.spyOn(fs, "existsSync"),
        jest.spyOn(fs, "openSync"),
        jest.spyOn(fs.promises, "open"),
        jest.spyOn(fs.promises, "readFile"),
      ];

      await expect(service.getImage(name)).resolves.toBeNull();

      for (const read of reads) {
        expect(read).not.toHaveBeenCalled();
      }
    });

    it("answers null for a non-string name", async () => {
      await expect(
        service.getImage(["alpha"] as unknown as string),
      ).resolves.toBeNull();
    });

    it("answers null for every picture when the bundle is missing", async () => {
      jest.spyOn(fs, "existsSync").mockReturnValue(false);

      await expect(service.getImage("alpha")).resolves.toBeNull();
    });
  });

  describe("search", () => {
    beforeEach(writeBundle);

    it("finds a section by its heading, with the page's lead paragraph scored too", () => {
      const { results } = service.search("alpha");

      expect(results).toEqual([
        expect.objectContaining({ page: "first-page", section: "alpha" }),
      ]);
    });

    it("boosts a section of the given context page", () => {
      // Both pages' lead paragraphs are "Lead."; an equal match is otherwise
      // broken by the pages' own order (first-page before second-page).
      const withoutContext = service.search("lead", { limit: 1 });
      const withContext = service.search("lead", {
        contextPage: "second-page",
        limit: 1,
      });

      expect(withoutContext.results[0].page).toBe("first-page");
      expect(withContext.results[0].page).toBe("second-page");
    });

    it("ignores a context page the bundle does not have, rather than refusing the search", () => {
      const { results } = service.search("alpha", {
        contextPage: "unknown-page",
      });

      expect(results).toEqual([
        expect.objectContaining({ page: "first-page", section: "alpha" }),
      ]);
    });

    it("answers nothing, not an error, when the bundle is missing", () => {
      jest.spyOn(fs, "existsSync").mockReturnValue(false);

      expect(service.search("alpha")).toEqual({ results: [], total: 0 });
    });

    it("never offers a section of a page whose file is gone", () => {
      fs.rmSync(path.join(helpDir, "second-page.md"));
      service = new HelpService();

      const { results } = service.search("lead");

      expect(results.some((r) => r.page === "second-page")).toBe(false);
    });
  });
});
