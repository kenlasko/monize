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
});
