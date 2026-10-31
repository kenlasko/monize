import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';

/**
 * ZAP 10027 matches ordinary words in comments. The reviewed public scripts
 * are the hand-written service worker and exact copies of these two installed
 * dependency assets. Unknown scripts and modified vendor copies fail this
 * guard; work-in-progress comments remain forbidden in our service worker.
 */

const PUBLIC_DIR = path.join(process.cwd(), 'public');

// Every file under public/ that a browser executes or renders as markup, and
// why it is allowed to ship unminified. A new entry is the moment to ask
// whether its comments say anything a visitor should not read.
const VERBATIM_SCRIPTS: Record<string, string> = {
  'sw.js':
    'the service worker: must be served at the origin root under a stable URL, so it is not a build artifact. Its comments describe behaviour, never a credential, host or unfinished work.',
};

// Separately reviewed from copy-vendor.mjs: adding a copied asset there must
// not authorize it here. Paths name exact files, never a directory exemption.
const REVIEWED_VENDOR_SCRIPTS: Readonly<Record<string, string>> = {
  'vendor/opencv/opencv.js': 'node_modules/@techstark/opencv-js/dist/opencv.js',
  'vendor/pdfjs/pdf.worker.min.mjs':
    'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
};

const SCRIPT_OR_MARKUP_RE = /\.(?:m?js|cjs|html?)$/i;

// Developer notes that mark unfinished or known-broken work: the part of rule
// 10027 that is a real disclosure rather than a keyword match on prose.
const WORK_IN_PROGRESS_RE = /\b(?:TODO|FIXME|XXX|HACK|BUGS?)\b/;

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function assertReviewedScripts(publicDir: string, projectDir: string) {
  const served = listFiles(publicDir)
    .map((file) => path.relative(publicDir, file).split(path.sep).join('/'))
    .filter((file) => SCRIPT_OR_MARKUP_RE.test(file))
    .sort();
  // Fresh checkouts may not have run predev/prebuild/pretest yet.
  const vendorFiles = Object.keys(REVIEWED_VENDOR_SCRIPTS).filter((file) =>
    fs.existsSync(path.join(publicDir, file)),
  );
  expect(served).toEqual(
    [...Object.keys(VERBATIM_SCRIPTS), ...vendorFiles].sort(),
  );
  const digest = (file: string) =>
    createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for (const file of vendorFiles) {
    expect(digest(path.join(publicDir, file)), file).toBe(
      digest(path.join(projectDir, REVIEWED_VENDOR_SCRIPTS[file])),
    );
  }
}

function withBuiltFixture(
  check: (publicDir: string, projectDir: string) => void,
) {
  const projectDir = fs.mkdtempSync(
    path.join(tmpdir(), 'monize-public-scripts-'),
  );
  const publicDir = path.join(projectDir, 'public');
  try {
    fs.mkdirSync(publicDir);
    fs.writeFileSync(
      path.join(publicDir, 'sw.js'),
      'self.addEventListener("fetch", () => {});',
    );
    for (const [file, source] of Object.entries(REVIEWED_VENDOR_SCRIPTS)) {
      for (const target of [
        path.join(publicDir, file),
        path.join(projectDir, source),
      ]) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
          target,
          '/* dependency license */ self.vendor = true;',
        );
      }
    }
    check(publicDir, projectDir);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

describe('scripts served verbatim from public/ (ZAP 10027)', () => {
  it('ships no unminified script or page beyond the reviewed list', () => {
    assertReviewedScripts(PUBLIC_DIR, process.cwd());
  });

  it('accepts exact installed copies after the vendor preparation step', () => {
    withBuiltFixture(assertReviewedScripts);
  });

  it('refuses an extra public script even beside reviewed vendor assets', () => {
    withBuiltFixture((publicDir, projectDir) => {
      fs.writeFileSync(
        path.join(publicDir, 'unexpected.js'),
        'self.unreviewed = true;',
      );
      expect(() => assertReviewedScripts(publicDir, projectDir)).toThrow();
    });
  });

  it.each(Object.keys(REVIEWED_VENDOR_SCRIPTS))(
    'refuses a modified copy of %s',
    (file) => {
      withBuiltFixture((publicDir, projectDir) => {
        fs.appendFileSync(
          path.join(publicDir, file),
          '\nself.modified = true;',
        );
        expect(() => assertReviewedScripts(publicDir, projectDir)).toThrow();
      });
    },
  );

  it.each(Object.keys(VERBATIM_SCRIPTS))(
    '%s carries no work-in-progress marker',
    (file) => {
      const offending = fs
        .readFileSync(path.join(PUBLIC_DIR, file), 'utf8')
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => WORK_IN_PROGRESS_RE.test(line))
        .map(({ line, number }) => `${file}:${number}: ${line}`);

      expect(offending).toEqual([]);
    },
  );
});
