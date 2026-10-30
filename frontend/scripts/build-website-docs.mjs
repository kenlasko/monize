#!/usr/bin/env node
// Builds the documentation site under website/docs/ from its Markdown.
//
//   npm run docs:build    write the generated files
//   npm run docs:check    exit 1 if a generated file is stale, or a link,
//                         an anchor or the page list is wrong
//
// website/docs/<slug>.md is the source; nav.json orders the pages into groups.
// Generated: <slug>.html for every page (index.md -> index.html, served at
// /docs/), search-index.json for the search box and sitemap.xml. The site has
// no build step on Cloudflare Pages, so the generated files are committed and
// `website-docs.test.ts` fails when they drift from the Markdown.
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from './website-docs/markdown.mjs';
import { renderShell, pageUrl, SITE } from './website-docs/template.mjs';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'website', 'docs');
const GENERATED = /\.html$|^search-index\.json$|^sitemap\.xml$/;

function build() {
  const errors = [];
  const nav = JSON.parse(readFileSync(join(DOCS, 'nav.json'), 'utf8'));
  const listed = nav.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.group })));
  const order = [{ slug: 'index', group: '', summary: '' }, ...listed];
  const slugs = new Set(order.map((p) => p.slug));
  const sources = readdirSync(DOCS)
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.slice(0, -3));

  for (const s of sources) if (!/^[a-z0-9-]+$/.test(s)) errors.push(`${s}.md: page names are lower-case letters, digits and hyphens`);
  for (const s of sources) if (!slugs.has(s)) errors.push(`${s}.md: not listed in nav.json`);
  for (const s of slugs) if (!sources.includes(s)) errors.push(`nav.json lists "${s}", but ${s}.md does not exist`);
  if (errors.length) return { errors };

  const pages = new Map(
    order.map((p) => {
      const markdown = readFileSync(join(DOCS, `${p.slug}.md`), 'utf8');
      return [p.slug, { ...p, ...renderPage({ slug: p.slug, markdown, docsDir: DOCS, slugs }) }];
    }),
  );

  for (const page of pages.values()) {
    for (const e of page.errors) errors.push(`${page.slug}.md: ${e}`);
    for (const l of page.links) {
      const target = pages.get(l.slug);
      if (target && l.hash && !target.ids.has(l.hash)) {
        errors.push(`${page.slug}.md: link "${l.text}" points at ${l.slug}.md#${l.hash}, which has no such heading`);
      }
    }
  }
  if (errors.length) return { errors };

  const landing = pages.get('index');
  landing.summary = landing.lede;
  const navWithTitles = nav.map((g) => ({
    group: g.group,
    pages: g.pages.map((p) => ({ ...p, title: pages.get(p.slug).title })),
  }));

  const files = new Map();
  order.forEach(({ slug }, i) => {
    const page = pages.get(slug);
    files.set(
      `${slug}.html`,
      renderShell({
        page,
        nav: navWithTitles,
        group: page.group,
        summary: page.summary,
        prev: i > 0 ? pages.get(order[i - 1].slug) : null,
        next: i < order.length - 1 ? pages.get(order[i + 1].slug) : null,
      }),
    );
  });

  const index = [...pages.values()].flatMap((page) =>
    page.sections.map((s) => ({
      u: `${pageUrl(page.slug)}${s.id ? `#${s.id}` : ''}`,
      p: page.title,
      h: s.heading,
      x: s.text,
    })),
  );
  files.set('search-index.json', `${JSON.stringify(index)}\n`);

  files.set(
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${order
      .map((p) => `  <url><loc>${SITE}${pageUrl(p.slug)}</loc></url>\n`)
      .join('')}</urlset>\n`,
  );

  const missingImages = [...pages.values()].flatMap((p) => p.missingImages.map((i) => `${p.slug}.md: ${i}`));
  return { errors, files, missingImages };
}

function main() {
  const check = process.argv.includes('--check');
  const { errors, files, missingImages } = build();
  if (errors.length) {
    process.stderr.write(`website/docs has ${errors.length} problem(s):\n  ${errors.join('\n  ')}\n`);
    process.exit(1);
  }

  const stale = readdirSync(DOCS).filter((n) => GENERATED.test(n) && !files.has(n));
  const changed = [...files].filter(([name, body]) => {
    const file = join(DOCS, name);
    return !existsSync(file) || readFileSync(file, 'utf8') !== body;
  });

  if (check) {
    if (changed.length || stale.length) {
      process.stderr.write(
        `website/docs is out of date with its Markdown (${[...changed.map(([n]) => n), ...stale].join(', ')}).\n` +
          'Edit the .md file, never the generated .html, then run "npm run docs:build" in frontend/.\n',
      );
      process.exit(1);
    }
    process.stdout.write(`website/docs is up to date (${files.size} generated files).\n`);
    return;
  }

  for (const [name, body] of changed) writeFileSync(join(DOCS, name), body);
  for (const name of stale) unlinkSync(join(DOCS, name));
  process.stdout.write(`website/docs: ${changed.length} written, ${stale.length} removed, ${files.size} total.\n`);
  if (missingImages.length) {
    process.stdout.write(
      `${missingImages.length} screenshot(s) referenced but not in website/docs/images/ (shown as "Screenshot pending"):\n  ${missingImages.join('\n  ')}\n`,
    );
  }
}

main();
