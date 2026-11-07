import { Injectable, Logger } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import {
  HELP_IMAGE_NAME_RE,
  HELP_IMAGE_REF_RE,
  HELP_INDEX_SLUG,
  HELP_ONLINE_BASE_URL,
  HELP_SLUG_RE,
} from "./help.constants";
import {
  HelpImage,
  HelpImageFile,
  HelpImageVariant,
  HelpManifest,
  HelpPage,
  HelpPageSummary,
  HelpTocEntry,
} from "./dto/help-response.dto";
import {
  HelpImageEntry,
  readBundledImage,
  readImageBundle,
} from "./help-images";
import { HelpSearchAnswer, HelpSearchSection, searchHelp } from "./help-search";

// The running version comes from the backend package.json at build/run time,
// matching ReleaseNotesService.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const backendPkg = require("../../package.json") as { version: string };

interface NavFile {
  group: string;
  pages: { slug: string; summary: string }[];
}

interface IndexEntry {
  u: string;
  p: string;
  h: string;
  x: string;
}

/**
 * Serves the user guide (`website/docs`) bundled into the backend image, so
 * in-app help matches the running version and works with no network. The
 * bundle never changes while the process runs, so the whole of it (about 25
 * small pages) is read once, on first use, and served from memory. The files
 * read are the ones `nav.json` names (plus the landing page); a request only
 * looks its slug up in that cache, so nothing it supplies reaches the
 * filesystem. The screenshots are listed with the pages and read per request,
 * by the path the listing found for the name looked up.
 */
@Injectable()
export class HelpService {
  private readonly logger = new Logger(HelpService.name);
  readonly currentVersion: string = backendPkg.version;

  // The guide text bundled in the image. It is read once, lazily, and never
  // written after that, so replicas (each with the same bundled copy) cannot
  // disagree; see the allowlist entries in process-local-state.guard.spec.ts.
  private readonly pages = new Map<string, HelpPageSummary>();
  /** Every page, read with the bundle; it is immutable, so none goes stale. */
  private readonly loaded = new Map<string, HelpPage>();
  /** The bundle's pictures by name, listed with the pages; see `#pages`. */
  private readonly images = new Map<string, HelpImageEntry>();
  /** Every page's sections, in document order, for `search`; see `#pages`. */
  private readonly sections: HelpSearchSection[] = [];
  private state: "unloaded" | "ready" | "unavailable" = "unloaded";

  getManifest(): HelpManifest {
    const available = this.load();
    return {
      version: this.currentVersion,
      available,
      pages: available ? [...this.pages.values()] : [],
    };
  }

  /** The page for a slug, or `null` for anything `nav.json` does not define. */
  getPage(slug: string): HelpPage | null {
    if (typeof slug !== "string" || !HELP_SLUG_RE.test(slug)) {
      return null;
    }
    if (!this.load()) {
      return null;
    }
    // Every page was read when the bundle loaded, so a request is answered from
    // memory and nothing it supplies ever reaches a filesystem call.
    return this.loaded.get(slug) ?? null;
  }

  /**
   * A bundled picture (`<name>` or `<name>.light`), or `null` for anything the
   * bundle does not hold. The name is looked up in the list read when the
   * bundle loaded and never joined into a path, so nothing a request supplies
   * reaches the filesystem; the file read is the one the listing found. Its
   * `revision` is the file's as read now, so a file changed since the listing
   * no longer matches the key its page still advertises.
   */
  async getImage(name: string): Promise<HelpImageFile | null> {
    if (typeof name !== "string" || !HELP_IMAGE_NAME_RE.test(name)) {
      return null;
    }
    if (!this.load()) {
      return null;
    }
    const entry = this.images.get(name);
    if (!entry) {
      return null;
    }
    try {
      const { data, revision } = await readBundledImage(entry);
      return {
        data,
        contentType: entry.contentType,
        revision: cacheKey(this.currentVersion, revision),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to read help image ${name}: ${message}`);
      return null;
    }
  }

  /**
   * Ranks the guide's sections against `query`. `contextPage` is a slug the
   * bundle actually has; anything else (unknown, or the manifest is
   * unavailable) searches with no context boost rather than refusing the
   * request, matching `getPage`'s treatment of a slug it does not have.
   */
  search(
    query: string,
    options: { contextPage?: string | null; limit?: number } = {},
  ): HelpSearchAnswer {
    if (!this.load()) {
      return { results: [], total: 0 };
    }
    const contextPage =
      options.contextPage && this.loaded.has(options.contextPage)
        ? options.contextPage
        : null;
    return searchHelp(this.sections, query, {
      contextPage,
      limit: options.limit,
    });
  }

  /** Reads the bundle on first use; true when there is a usable one. */
  private load(): boolean {
    if (this.state === "unloaded") {
      this.state = this.readBundle() ? "ready" : "unavailable";
    }
    return this.state === "ready";
  }

  private readBundle(): boolean {
    const directory = this.resolveDirectory();
    if (!directory) {
      this.logger.warn(
        "Help directory not found; in-app help will report itself unavailable",
      );
      return false;
    }

    try {
      const nav = JSON.parse(
        fs.readFileSync(path.join(directory, "nav.json"), "utf-8"),
      ) as NavFile[];
      const index = JSON.parse(
        fs.readFileSync(path.join(directory, "search-index.json"), "utf-8"),
      ) as IndexEntry[];

      // Each index entry's slug and anchor, parsed once here and reused
      // below for both the pages' tables of contents and the search
      // sections, so a future change to `u`'s format has one place to fix.
      const parsedIndex = index.map((entry) => {
        const [pagePath, anchor] = entry.u.replace(/^\/docs\//, "").split("#");
        return {
          slug: pagePath === "" ? HELP_INDEX_SLUG : pagePath,
          anchor,
          entry,
        };
      });

      // Built locally and copied in only once the whole bundle parsed, so a
      // failure part-way leaves the cache empty rather than half-filled.
      const titles = new Map<string, string>();
      const sections = new Map<string, { id: string; heading: string }[]>();
      for (const { slug, anchor, entry } of parsedIndex) {
        titles.set(slug, entry.p);
        if (anchor) {
          const list = sections.get(slug) ?? [];
          list.push({ id: anchor, heading: entry.h });
          sections.set(slug, list);
        }
      }

      const pages = new Map<string, HelpPageSummary>();
      pages.set(HELP_INDEX_SLUG, {
        slug: HELP_INDEX_SLUG,
        title: titles.get(HELP_INDEX_SLUG) ?? HELP_INDEX_SLUG,
        summary: "",
        group: "",
      });
      for (const group of nav) {
        for (const page of group.pages) {
          if (!HELP_SLUG_RE.test(page.slug)) {
            continue;
          }
          pages.set(page.slug, {
            slug: page.slug,
            title: titles.get(page.slug) ?? page.slug,
            summary: page.summary,
            group: group.group,
          });
        }
      }
      const images = readImageBundle(directory, (message) =>
        this.logger.warn(message),
      );

      // Read every page now, by the slugs nav.json defines. A page whose file
      // is missing is logged and left out, so it answers 404 like an unknown one.
      const loaded = new Map<string, HelpPage>();
      for (const [slug, summary] of pages) {
        const markdown = this.readPage(directory, slug);
        if (markdown === null) {
          continue;
        }
        loaded.set(slug, {
          slug,
          title: summary.title,
          group: summary.group,
          markdown,
          toc: this.buildToc(slug, markdown, sections.get(slug) ?? []),
          onlineUrl:
            slug === HELP_INDEX_SLUG
              ? `${HELP_ONLINE_BASE_URL}/`
              : `${HELP_ONLINE_BASE_URL}/${slug}`,
          images: pageImages(markdown, images, this.currentVersion),
        });
      }

      // Mirrors the index's own order, which is document order within each
      // page in `nav.json`'s order, so a tie in the scorer reads as stable.
      // A page whose file went missing above is excluded here too, so search
      // never answers a section the panel cannot open.
      const searchSections: HelpSearchSection[] = [];
      for (const { slug, anchor, entry } of parsedIndex) {
        if (!loaded.has(slug)) continue;
        searchSections.push({
          page: slug,
          section: anchor ?? null,
          pageTitle: entry.p,
          heading: entry.h,
          text: entry.x,
        });
      }

      for (const [slug, summary] of pages) {
        this.pages.set(slug, summary);
      }
      for (const [slug, page] of loaded) {
        this.loaded.set(slug, page);
      }
      for (const [name, entry] of images) {
        this.images.set(name, entry);
      }
      this.sections.push(...searchSections);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to load the help bundle: ${message}`);
      return false;
    }
  }

  /** A page's Markdown; `slug` always comes from nav.json, never a request. */
  private readPage(directory: string, slug: string): string | null {
    try {
      return fs.readFileSync(path.join(directory, `${slug}.md`), "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to read help page ${slug}: ${message}`);
      return null;
    }
  }

  /**
   * The search index lists every `##`/`###` section of a page in document
   * order but not its level, so the level comes from the Markdown headings,
   * paired by position. When the two disagree (a heading the scanner cannot
   * see) every entry falls back to depth 2 rather than guessing.
   */
  private buildToc(
    slug: string,
    markdown: string,
    sections: { id: string; heading: string }[],
  ): HelpTocEntry[] {
    const depths = headingDepths(markdown);
    const matched = depths.length === sections.length;
    if (!matched && sections.length > 0) {
      this.logger.warn(
        `Help page ${slug}: ${depths.length} headings but ${sections.length} index sections; table of contents depths are approximate`,
      );
    }
    return sections.map((section, i) => ({
      depth: matched ? depths[i] : 2,
      id: section.id,
      heading: section.heading,
    }));
  }

  /**
   * Locate the help directory. Mirrors ReleaseNotesService: the image copy at
   * `./help` first, then the repository's `website/docs`, relative to the
   * working directory and to this file. A candidate must hold `nav.json`. The
   * bundle lives at a known location, so there is no configuration knob.
   */
  private resolveDirectory(): string | null {
    const candidates = [
      path.resolve(process.cwd(), "help"),
      path.resolve(__dirname, "..", "..", "help"),
      path.resolve(process.cwd(), "..", "website", "docs"),
      path.resolve(process.cwd(), "website", "docs"),
      path.resolve(__dirname, "..", "..", "..", "website", "docs"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, "nav.json"))) {
        return candidate;
      }
    }
    return null;
  }
}

/**
 * The pictures a page's Markdown names that the bundle holds, each with its
 * light twin when there is one, in the order the page shows them.
 */
function pageImages(
  markdown: string,
  images: ReadonlyMap<string, HelpImageEntry>,
  version: string,
): Record<string, HelpImage> {
  const variant = (name: string, entry: HelpImageEntry): HelpImageVariant => ({
    name,
    width: entry.width,
    height: entry.height,
    revision: cacheKey(version, entry.revision),
  });
  const found = new Map<string, HelpImage>();
  for (const [, name] of markdown.matchAll(HELP_IMAGE_REF_RE)) {
    const dark = images.get(name);
    if (!dark || found.has(name)) {
      continue;
    }
    const light = images.get(`${name}.light`);
    found.set(name, {
      dark: variant(name, dark),
      light: light ? variant(`${name}.light`, light) : null,
    });
  }
  return Object.fromEntries(found);
}

/**
 * A picture's cache key: the running version and the file's own revision, so
 * a browser keeps a picture only until a release or a changed file replaces it.
 */
function cacheKey(version: string, revision: string): string {
  return `${version}-${revision}`;
}

/** Levels (2 or 3) of the `##`/`###` headings outside code fences, in order. */
function headingDepths(markdown: string): number[] {
  const depths: number[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) {
        fence = marker;
      } else if (fence === marker) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      continue;
    }
    const heading = /^ {0,3}(#{2,3})\s+\S/.exec(line);
    if (heading) {
      depths.push(heading[1].length);
    }
  }
  return depths;
}
