import { Injectable, Logger } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import {
  HELP_INDEX_SLUG,
  HELP_ONLINE_BASE_URL,
  HELP_SLUG_RE,
} from "./help.constants";
import {
  HelpManifest,
  HelpPage,
  HelpPageSummary,
  HelpTocEntry,
} from "./dto/help-response.dto";

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
}

/**
 * Serves the user guide (`website/docs`) bundled into the backend image, so
 * in-app help matches the running version and works with no network. The
 * bundle never changes while the process runs, so everything is loaded lazily
 * and cached. A page is only ever read by looking its slug up in the set
 * `nav.json` defines (plus the landing page); user input is never joined into
 * a path.
 */
@Injectable()
export class HelpService {
  private readonly logger = new Logger(HelpService.name);
  readonly currentVersion: string = backendPkg.version;

  // The guide text bundled in the image. It is read once, lazily, and never
  // written after that, so replicas (each with the same bundled copy) cannot
  // disagree; see the allowlist entries in process-local-state.guard.spec.ts.
  private readonly pages = new Map<string, HelpPageSummary>();
  /** Table of contents per slug, derived from the search index. */
  private readonly sections = new Map<
    string,
    { id: string; heading: string }[]
  >();
  /** Pages read so far; the bundle is immutable, so an entry never goes stale. */
  private readonly loaded = new Map<string, HelpPage>();
  private directory: string | null = null;
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
    if (!this.load() || this.directory === null) {
      return null;
    }
    const summary = this.pages.get(slug);
    if (!summary) {
      return null;
    }

    const cached = this.loaded.get(slug);
    if (cached) {
      return cached;
    }

    let markdown: string;
    try {
      // `slug` is a key of the nav-derived map, so the file name is trusted.
      markdown = fs.readFileSync(
        path.join(this.directory, `${slug}.md`),
        "utf-8",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to read help page ${slug}: ${message}`);
      return null;
    }

    const page: HelpPage = {
      slug,
      title: summary.title,
      group: summary.group,
      markdown,
      toc: this.buildToc(slug, markdown, this.sections.get(slug) ?? []),
      onlineUrl:
        slug === HELP_INDEX_SLUG
          ? `${HELP_ONLINE_BASE_URL}/`
          : `${HELP_ONLINE_BASE_URL}/${slug}`,
    };
    this.loaded.set(slug, page);
    return page;
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

      // Built locally and copied in only once the whole bundle parsed, so a
      // failure part-way leaves the cache empty rather than half-filled.
      const titles = new Map<string, string>();
      const sections = new Map<string, { id: string; heading: string }[]>();
      for (const entry of index) {
        const [pagePath, anchor] = entry.u.replace(/^\/docs\//, "").split("#");
        const slug = pagePath === "" ? HELP_INDEX_SLUG : pagePath;
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
      this.directory = directory;
      for (const [slug, summary] of pages) {
        this.pages.set(slug, summary);
      }
      for (const [slug, list] of sections) {
        this.sections.set(slug, list);
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to load the help bundle: ${message}`);
      return false;
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
