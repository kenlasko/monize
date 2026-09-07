import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname, '..', '..');

/** The one module allowed to name the engine package or its script. */
const ENGINE_OWNER = 'lib/document-scanner/opencv-engine.ts';

/** The one module allowed to construct the scanner worker. */
const WORKER_OWNER = 'lib/document-scanner/document-scan-client.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Blank comments while preserving line breaks, so an offender still reports the
 * right line.
 *
 * This scan's subjects have to be named in prose -- the engine module explains
 * at length why it does not import the package -- so matching raw text would
 * fail on the explanation, and the cheap way out is to weaken the explanation.
 */
export function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) =>
      prefix.concat(' '.repeat(match.length - prefix.length)),
    );
}

const files = sourceFiles(SRC_ROOT).map((file) => ({
  rel: relative(SRC_ROOT, file).split('\\').join('/'),
  code: blankComments(readFileSync(file, 'utf8')),
}));

/**
 * The scanner engine is several megabytes, and where it is referenced decides
 * what every page costs.
 *
 * Referenced from a component it lands in a shared chunk and every visitor pays
 * for a document scanner they never opened; confined to the engine module --
 * itself imported only from the worker -- it is fetched the first time somebody
 * actually scans something (`I7`).
 */
describe('the scanner engine is reached from one place', () => {
  it('finds source files to scan', () => {
    // A broken walk would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(200);
  });

  it('names the OpenCV package nowhere but the engine module', () => {
    const offenders = files
      .filter(
        ({ rel, code }) =>
          rel !== ENGINE_OWNER && code.includes('@techstark/opencv-js'),
      )
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('names the engine script URL nowhere but the engine module', () => {
    // A second copy of the path is how a rename leaves one caller fetching a
    // file that is no longer there, with no error until somebody scans.
    const offenders = files
      .filter(
        ({ rel, code }) =>
          rel !== ENGINE_OWNER && code.includes('/vendor/opencv/'),
      )
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('constructs the scanner worker in one place', () => {
    const offenders = files
      .filter(
        ({ rel, code }) =>
          rel !== WORKER_OWNER && /new\s+Worker\s*\(/.test(code),
      )
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('keeps the worker entry point free of decisions', () => {
    // Everything the worker decides lives in `document-scan-messages.ts`, which
    // runs anywhere; a branch added to the entry point is a branch no unit
    // suite can reach, because no test environment provides a real Worker.
    const worker = files.find(
      ({ rel }) => rel === 'lib/document-scanner/document-scan.worker.ts',
    );
    expect(worker).toBeDefined();

    const statements = worker!.code
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(statements.length).toBeLessThan(25);
    expect(worker!.code).not.toMatch(/\bif\s*\(|\bfor\s*\(|\bwhile\s*\(/);
  });

  describe('the scan itself', () => {
    it('catches a reference in code', () => {
      expect(
        blankComments("import cv from '@techstark/opencv-js';").includes(
          '@techstark/opencv-js',
        ),
      ).toBe(true);
      expect(/new\s+Worker\s*\(/.test(blankComments('new Worker(url)'))).toBe(
        true,
      );
    });

    it('ignores a reference in a comment', () => {
      expect(
        blankComments("// we do not import '@techstark/opencv-js'").includes(
          '@techstark',
        ),
      ).toBe(false);
      expect(
        blankComments('/* new Worker( ) is built here */').includes(
          'new Worker(',
        ),
      ).toBe(false);
    });

    it('keeps line numbers stable across a block comment', () => {
      const blanked = blankComments('a\n/* one\ntwo */\nb');
      expect(blanked.split('\n')).toHaveLength(4);
      expect(blanked.split('\n')[3]).toBe('b');
    });

    it('does not mistake a URL for a comment', () => {
      expect(blankComments('const u = "https://x.test"; // t')).toContain(
        '"https://x.test"',
      );
    });
  });
});
