// Markdown -> HTML for the documentation pages under website/docs/.
//
// Rendering goes through react-markdown + remark-gfm, the same pair the app
// already ships, so the site needs no Markdown dependency of its own. One remark
// plugin (`prepare`) does everything the wiki's GitHub rendering used to do for
// us and records what the template and the link check need: heading ids in
// GitHub's slug format (so a link written for the wiki still lands), the page
// title, the table of contents, searchable sections, every internal link and
// every image.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const CALLOUTS = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };

/** Plain text of an mdast node, the way GitHub reads a heading for its slug. */
export function textOf(node) {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') return node.value;
  return (node.children ?? []).map(textOf).join('');
}

/** GitHub's heading slug: lower case, punctuation dropped, spaces to hyphens. */
export function githubSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

function slugger() {
  const seen = new Map();
  return (text) => {
    const base = githubSlug(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

/** Width and height from a PNG's IHDR chunk, so an image reserves its box before it loads. */
function pngSize(file) {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function element(tag, props, children = []) {
  return { type: 'element-like', data: { hName: tag, hProperties: props }, children };
}

/**
 * Remark plugin. `page` is filled in as the tree is walked:
 * title, toc [{depth, id, text}], ids (Set), links [{slug, hash, text}],
 * missingImages [], sections [{id, heading, text}], errors [].
 */
function prepare({ page, docsDir, slugs }) {
  return () => (tree) => {
    const slug = slugger();
    let section = { id: '', heading: '', parts: [] };
    page.sections.push(section);

    // The wiki ruled a line before every section; an h2 draws its own rule,
    // so a `---` directly above one is dropped rather than doubled.
    const walk = (parent) => {
      const kept = [];
      const children = parent.children ?? [];
      children.forEach((node, i) => {
        const next = children[i + 1];
        if (node.type === 'thematicBreak' && next?.type === 'heading' && next.depth === 2) return;
        const replaced = visit(node, parent);
        if (replaced !== null) kept.push(replaced);
      });
      parent.children = kept;
    };

    const visit = (node, parent) => {
      if (node.type === 'heading') {
        const text = textOf(node).trim();
        const id = slug(text);
        page.ids.add(id);
        if (node.depth === 1) {
          if (page.title) page.errors.push(`more than one "# " title ("${text}")`);
          page.title = text;
          return null;
        }
        node.data = { hProperties: { id } };
        if (node.depth <= 3) page.toc.push({ depth: node.depth, id, text });
        if (node.depth <= 3) {
          section = { id, heading: text, parts: [] };
          page.sections.push(section);
        }
        return node;
      }

      // The landing page's first paragraph is its lede: the template shows it
      // under the title, above the page cards, so it is not repeated below them.
      if (page.slug === 'index' && parent === tree && node.type === 'paragraph' && !page.lede) {
        page.lede = textOf(node).trim();
        return null;
      }

      // `<a id="name"></a>` on a line of its own parses as a paragraph of two
      // inline HTML nodes; it is the one piece of HTML kept, as a link target
      // for a heading whose own slug is taken.
      if (node.type === 'paragraph' && node.children.every((c) => c.type === 'html')) {
        node = { type: 'html', value: node.children.map((c) => c.value).join('') };
      }

      if (node.type === 'html') {
        const anchor = node.value.trim().match(/^<a id="([a-z0-9-]+)"><\/a>$/);
        if (anchor) {
          page.ids.add(anchor[1]);
          return element('span', { id: anchor[1], className: ['anchor-target'] });
        }
        if (/^<!--[\s\S]*-->$/.test(node.value.trim())) return null;
        page.errors.push(`raw HTML is not rendered; write it as Markdown: ${node.value.trim().slice(0, 60)}`);
        return null;
      }

      if (node.type === 'blockquote') {
        const first = node.children[0];
        const lead = first?.type === 'paragraph' ? first.children[0] : undefined;
        const marker = lead?.type === 'text' ? lead.value.match(/^\[!([A-Z]+)\]\s*/) : null;
        if (marker && CALLOUTS[marker[1]]) {
          lead.value = lead.value.slice(marker[0].length);
          if (!lead.value) first.children.shift();
          if (first.children.length === 0) node.children.shift();
          const kind = marker[1].toLowerCase();
          node.data = { hName: 'aside', hProperties: { className: ['callout', `callout-${kind}`] } };
          node.children.unshift(
            element('p', { className: ['callout-title'] }, [{ type: 'text', value: CALLOUTS[marker[1]] }]),
          );
        }
      }

      if (node.type === 'link') {
        const url = node.url;
        const internal = url.match(/^([a-z0-9-]+)\.md(#[^\s]*)?$/);
        if (internal) {
          const [, target, hash = ''] = internal;
          if (!slugs.has(target)) page.errors.push(`links to ${url}, which is not a page in nav.json`);
          page.links.push({ slug: target, hash: hash.slice(1), text: textOf(node) });
          node.url = `/docs/${target === 'index' ? '' : target}${hash}`;
        } else if (url.startsWith('#')) {
          page.links.push({ slug: page.slug, hash: url.slice(1), text: textOf(node) });
        } else if (/^https?:\/\//.test(url) || url.startsWith('mailto:')) {
          node.data = { hProperties: { rel: ['noopener'], className: ['ext'] } };
        } else {
          page.errors.push(`link "${url}" is neither another page (name.md#anchor), an anchor nor an absolute URL`);
        }
      }

      if (node.type === 'paragraph' && node.children.length === 1 && node.children[0].type === 'image') {
        const figure = image(node.children[0]);
        if (figure.type === 'image') {
          const caption = figure.alt ? [element('figcaption', {}, [{ type: 'text', value: figure.alt }])] : [];
          return element('figure', {}, [figure, ...caption]);
        }
        return figure;
      }
      if (node.type === 'image') return image(node);

      if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') section.parts.push(node.value);
      if (node.children) walk(node);
      return node;
    };

    const image = (node) => {
      const name = node.url.match(/^images\/([a-z0-9-]+\.png)$/)?.[1];
      const file = name && join(docsDir, 'images', name);
      if (!file || !existsSync(file)) {
        page.missingImages.push(node.url);
        return element('span', { className: ['shot-missing'], role: 'img', ariaLabel: node.alt || 'Screenshot' }, [
          { type: 'text', value: `Screenshot pending: ${node.alt || node.url}` },
        ]);
      }
      const size = pngSize(file) ?? {};
      node.url = `/docs/images/${name}`;
      node.data = { hProperties: { ...size, loading: 'lazy', decoding: 'async' } };
      return node;
    };

    walk(tree);
    page.sections = page.sections
      .map((s) => ({ id: s.id, heading: s.heading, text: s.parts.join(' ').replace(/\s+/g, ' ').trim() }))
      .filter((s) => s.heading || s.text);
  };
}

const HEADING_LINK = (Tag) =>
  function Heading({ node: _node, children, ...props }) {
    return h(
      Tag,
      props,
      children,
      h('a', { className: 'hlink', href: `#${props.id}`, 'aria-label': 'Link to this section' }, '#'),
    );
  };

const COMPONENTS = {
  h2: HEADING_LINK('h2'),
  h3: HEADING_LINK('h3'),
  h4: HEADING_LINK('h4'),
  table: ({ node: _node, ...props }) => h('div', { className: 'table-wrap' }, h('table', props)),
};

function record(slug) {
  return { slug, title: '', lede: '', toc: [], ids: new Set(), links: [], missingImages: [], sections: [], errors: [] };
}

function markdownElement({ markdown, docsDir, slugs }, page) {
  return h(
    Markdown,
    { remarkPlugins: [remarkGfm, prepare({ page, docsDir, slugs })], components: COMPONENTS },
    markdown,
  );
}

/**
 * Read one page's Markdown. Returns the page record (title, table of contents,
 * links, sections) with `content`, a React element the page shell renders in
 * place -- the body never exists as an HTML string spliced into the shell.
 * The record is filled by a first render, because the shell needs the title and
 * the table of contents before it can place the body; the second render, inside
 * the shell, fills a record nobody reads.
 */
export function renderPage({ slug, markdown, docsDir, slugs }) {
  const page = record(slug);
  renderToStaticMarkup(markdownElement({ markdown, docsDir, slugs }, page));
  if (!page.title) page.errors.push('has no "# " title');
  page.content = markdownElement({ markdown, docsDir, slugs }, record(slug));
  return page;
}
