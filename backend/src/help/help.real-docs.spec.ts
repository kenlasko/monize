import fs from "fs";
import * as path from "path";
import { Logger } from "@nestjs/common";
import { HelpService } from "./help.service";

/**
 * The backend twin of the frontend's docs-links.test.ts: loads the real
 * `website/docs` (the source-tree candidate, since cwd has no `help/` here)
 * and fails when the bundle the app serves and the generated website disagree.
 */
const DOCS = path.resolve(__dirname, "..", "..", "..", "website", "docs");

describe("HelpService against the repository's website/docs", () => {
  const warn = jest
    .spyOn(Logger.prototype, "warn")
    .mockImplementation(() => undefined);
  const service = new HelpService();
  const nav = JSON.parse(
    fs.readFileSync(path.join(DOCS, "nav.json"), "utf-8"),
  ) as { group: string; pages: { slug: string }[] }[];
  const slugs = ["index", ...nav.flatMap((g) => g.pages.map((p) => p.slug))];

  afterAll(() => warn.mockRestore());

  it("is available and lists the landing page and every nav page", () => {
    const manifest = service.getManifest();

    expect(manifest.available).toBe(true);
    expect(manifest.pages.map((p) => p.slug)).toEqual(slugs);
    expect(slugs.length).toBeGreaterThan(20);
    for (const page of manifest.pages) {
      expect(page.title).not.toBe(page.slug);
    }
  });

  it.each(slugs)(
    "serves %s with every toc anchor present in its HTML",
    (slug) => {
      const page = service.getPage(slug);

      expect(page).not.toBeNull();
      expect(page?.markdown.startsWith("# ")).toBe(true);
      expect(page?.title.length).toBeGreaterThan(0);

      const html = fs.readFileSync(path.join(DOCS, `${slug}.html`), "utf-8");
      for (const entry of page?.toc ?? []) {
        expect([2, 3]).toContain(entry.depth);
        expect(html).toContain(`id="${entry.id}"`);
      }
    },
  );

  it("computes toc depths from the Markdown without falling back", () => {
    for (const slug of slugs) {
      service.getPage(slug);
    }

    expect(warn).not.toHaveBeenCalled();
  });

  it("matches the markdown headings to the toc ids", () => {
    const page = service.getPage("budgets");

    expect(page?.toc[0]).toEqual({
      depth: 2,
      id: "overview",
      heading: "Overview",
    });
    expect(
      page?.toc.find((t) => t.id === "step-1-analyze-spending")?.depth,
    ).toBe(3);
  });
  /**
   * The website's `<img>` tags for the guide's screenshots on a page, by
   * picture: what a reader of monize.net sees, and so what the panel shows.
   */
  function websitePictures(slug: string) {
    const html = fs.readFileSync(path.join(DOCS, `${slug}.html`), "utf-8");
    const shown = new Map<string, { width: number; height: number }>();
    for (const [tag] of html.matchAll(
      /<img [^>]*src="\/docs\/images\/[^"]+"[^>]*>/g,
    )) {
      const file = /src="\/docs\/images\/([a-z0-9-]+(?:\.light)?)\.png"/.exec(
        tag,
      );
      const width = /\swidth="(\d+)"/.exec(tag);
      const height = /\sheight="(\d+)"/.exec(tag);
      expect(file && width && height).toBeTruthy();
      shown.set(file![1], {
        width: Number(width![1]),
        height: Number(height![1]),
      });
    }
    return shown;
  }

  it.each(slugs)(
    "%s offers every picture its website page shows, in the same themes and sizes",
    (slug) => {
      const page = service.getPage(slug);
      const offered = new Map<string, { width: number; height: number }>();
      for (const image of Object.values(page?.images ?? {})) {
        for (const variant of [image.dark, image.light]) {
          if (variant) {
            offered.set(variant.name, {
              width: variant.width,
              height: variant.height,
            });
          }
        }
      }

      expect(offered).toEqual(websitePictures(slug));
    },
  );

  it("offers every picture a page names that the guide has, with its light twin", () => {
    const files = new Set(fs.readdirSync(path.join(DOCS, "images")));
    let pictures = 0;
    for (const slug of slugs) {
      const page = service.getPage(slug);
      for (const [, name] of (page?.markdown ?? "").matchAll(
        /images\/([a-z0-9-]+)\.png/g,
      )) {
        const image = page?.images[name];
        if (!files.has(`${name}.png`)) {
          // "Screenshot pending" on the website: the panel shows the caption.
          expect(image).toBeUndefined();
          continue;
        }
        pictures++;
        expect(image?.dark.name).toBe(name);
        expect(image?.light?.name ?? null).toBe(
          files.has(`${name}.light.png`) ? `${name}.light` : null,
        );
      }
    }
    expect(pictures).toBeGreaterThan(200);
  });

  it("serves a bundled picture as the PNG the source tree holds", async () => {
    const image = await service.getImage("budgets-page");

    expect(image?.contentType).toBe("image/png");
    expect(image?.data).toEqual(
      fs.readFileSync(path.join(DOCS, "images", "budgets-page.png")),
    );
  });

  /**
   * Real questions a reader might type, each with the section it must land
   * in the top three results -- the search scorer's quality bar. This fixture
   * doubles as the assistant tool's own quality check (plan 6).
   */
  const REAL_QUESTIONS: [string, string, string][] = [
    ["how do I split a transaction", "transactions", "split-transactions"],
    ["change my default currency", "currency-management", "home-currency"],
    ["restore a backup", "backup-and-restore", "restoring-from-a-backup"],
    ["add a mortgage", "accounts", "mortgage-setup"],
    ["two-factor", "settings-and-security", "two-factor-authentication-2fa"],
  ];

  describe("search", () => {
    it.each(REAL_QUESTIONS)(
      "%j lands %s#%s in the top three",
      (query, page, section) => {
        const { results } = service.search(query, { limit: 3 });

        expect(results.slice(0, 3)).toEqual(
          expect.arrayContaining([expect.objectContaining({ page, section })]),
        );
      },
    );
  });

  /**
   * The same questions through what the assistant and the MCP tool call, with
   * the issue's own ("how do I undo a split?": the steps are under Creating a
   * Split). This tests retrieval, the part the code controls; how a model uses
   * the sections is checked by hand.
   */
  describe("getLlmHelp", () => {
    it.each([
      ...REAL_QUESTIONS,
      ["how do I undo a split?", "transactions", "creating-a-split"],
    ])("%j answers %s#%s with its text and link", (query, page, section) => {
      const answer = service.getLlmHelp(query);
      const url = `https://www.monize.net/docs/${page}#${section}`;
      const hit = answer.sections.find((s) => s.url === url);

      expect(answer.available).toBe(true);
      expect(answer.language).toBe("en");
      expect(hit).toBeDefined();
      expect(hit?.text.length).toBeGreaterThan(0);
      expect(
        fs.readFileSync(path.join(DOCS, `${page}.html`), "utf-8"),
      ).toContain(`id="${section}"`);
    });

    it("keeps the whole answer to a bounded size at the largest limit", () => {
      const answer = service.getLlmHelp("account transaction", { limit: 99 });

      expect(answer.sections).toHaveLength(8);
      expect(JSON.stringify(answer).length).toBeLessThan(16_000);
    });
  });
});
