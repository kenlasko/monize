import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The user documentation at monize.net/docs is Markdown in `website/docs/`
 * turned into static pages by `scripts/build-website-docs.mjs`. Cloudflare
 * Pages serves the folder as it is, with no build step, so the generated HTML
 * is committed beside its Markdown -- and goes stale the moment someone edits
 * one without the other. The build's `--check` mode is what this runs: it fails
 * on a stale or hand-edited page, a page missing from `nav.json`, a link to a
 * page that does not exist, and an anchor that no heading on the target page
 * produces (the app's help links point at those anchors).
 *
 * The site is on Cloudflare Pages' free plan. Its limits are per deployment
 * and a breach fails the upload, so they are checked here rather than found out
 * at deploy time: https://developers.cloudflare.com/pages/platform/limits/
 *
 * It lives here for the same reason `website-dom-safety.test.ts` does: the
 * frontend's Vitest is the nearest JavaScript test runner to `website/`, and
 * the generator renders through the frontend's own react-markdown.
 */
const FRONTEND = join(__dirname, '..', '..');
const SITE = join(FRONTEND, '..', 'website');

const PAGES_MAX_FILES = 20_000;
const PAGES_MAX_FILE_BYTES = 25 * 1024 * 1024;
const PAGES_MAX_HEADER_RULES = 100;
const PAGES_MAX_STATIC_REDIRECTS = 2_000;
const PAGES_MAX_DYNAMIC_REDIRECTS = 100;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

function meaningfulLines(file: string): string[] {
  return readFileSync(join(SITE, file), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

describe('website documentation', () => {
  it('generated pages match their Markdown, and every link and anchor resolves', () => {
    let output = '';
    try {
      output = execFileSync(process.execPath, ['scripts/build-website-docs.mjs', '--check'], {
        cwd: FRONTEND,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string };
      expect.fail(`${e.stderr ?? ''}${e.stdout ?? ''}`);
    }
    expect(output).toMatch(/up to date/);
  });
});

describe('website fits the Cloudflare Pages free plan', () => {
  const files = walk(SITE);

  it(`has at most ${PAGES_MAX_FILES} files`, () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThanOrEqual(PAGES_MAX_FILES);
  });

  it('has no file over 25 MiB', () => {
    const tooBig = files
      .filter((file) => statSync(file).size > PAGES_MAX_FILE_BYTES)
      .map((file) => `website/${relative(SITE, file)}`);
    expect(tooBig).toEqual([]);
  });

  it(`has at most ${PAGES_MAX_HEADER_RULES} _headers rules`, () => {
    const rules = meaningfulLines('_headers').filter((line) => line.startsWith('/'));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.length).toBeLessThanOrEqual(PAGES_MAX_HEADER_RULES);
  });

  it('stays within the static and dynamic _redirects limits', () => {
    const rules = meaningfulLines('_redirects');
    const dynamic = rules.filter((line) => /[*:]/.test(line.split(/\s+/)[0]));
    expect(dynamic.length).toBeLessThanOrEqual(PAGES_MAX_DYNAMIC_REDIRECTS);
    expect(rules.length - dynamic.length).toBeLessThanOrEqual(PAGES_MAX_STATIC_REDIRECTS);
  });
});
