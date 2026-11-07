import type { HelpTocEntry } from '@/lib/help';

/**
 * Remark step that gives the guide's Markdown the meaning the website gives it
 * (`scripts/website-docs/markdown.mjs`), so the same page reads the same in the
 * app and on monize.net:
 *
 * - every `##` and deeper heading gets a GitHub-style slug id. The `##` and
 *   `###` ids are taken from the page's table of contents, in order, so the
 *   two renderers cannot disagree about an anchor a link names; deeper headings
 *   are slugged here with the same duplicate counter the website uses.
 * - the page's `#` title is dropped (the panel header shows it).
 * - `<a id="x"></a>` on a line of its own becomes an empty `span` carrying the
 *   id, a link target. It is the one piece of HTML kept; any other raw HTML is
 *   dropped.
 * - `> [!NOTE]` style blockquotes become `aside` elements tagged with their
 *   kind; the renderer draws the label.
 * - an image on its own line becomes a block, and each image is tagged with the
 *   `##`/`###` section it sits in so its "view online" link can name it.
 * - a rule directly above a `##` is dropped, as the website drops it.
 *
 * Hand-written walker over minimal mdast shapes, like `remark-issue-links.ts`,
 * rather than a dependency for one tree traversal.
 */

interface MdNode {
  type: string;
  value?: string;
  depth?: number;
  alt?: string | null;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

const CALLOUT_KINDS = new Set(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']);
const ANCHOR = /^<a id="([a-z0-9-]+)"><\/a>$/;

/** Plain text of a node, the way GitHub reads a heading for its slug. */
function textOf(node: MdNode): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
    return node.value ?? '';
  }
  return (node.children ?? []).map(textOf).join('');
}

/** GitHub's heading slug: lower case, punctuation dropped, spaces to hyphens. */
export function githubSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

function isBlank(node: MdNode): boolean {
  return node.type === 'text' && (node.value ?? '').trim() === '';
}

export function remarkHelp({ toc }: { toc: readonly HelpTocEntry[] }) {
  return () => (tree: MdNode) => {
    const seen = new Map<string, number>();
    let tocIndex = 0;
    let section = '';

    const slug = (text: string): string => {
      const base = githubSlug(text);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return n === 0 ? base : `${base}-${n}`;
    };

    const visit = (node: MdNode): MdNode | null => {
      if (node.type === 'heading') {
        const depth = node.depth ?? 2;
        if (depth === 1) return null;
        const own = slug(textOf(node).trim());
        const id = depth <= 3 ? (toc[tocIndex++]?.id ?? own) : own;
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } };
        if (depth <= 3) section = id;
        return node;
      }

      if (node.type === 'html') return null;

      if (node.type === 'paragraph') {
        const parts = node.children ?? [];
        if (parts.length > 0 && parts.every((c) => c.type === 'html')) {
          const anchor = parts
            .map((c) => c.value ?? '')
            .join('')
            .trim()
            .match(ANCHOR);
          if (anchor) {
            return {
              type: 'paragraph',
              data: { hName: 'span', hProperties: { id: anchor[1] } },
              children: [],
            };
          }
          return null;
        }
        const solid = parts.filter((c) => !isBlank(c));
        if (solid.length > 0 && solid.every((c) => c.type === 'image')) {
          node.data = {
            hName: 'div',
            hProperties: { className: ['help-shots'] },
          };
        }
      }

      if (node.type === 'image') {
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, dataSection: section },
        };
        return node;
      }

      if (node.type === 'blockquote') {
        const first = node.children?.[0];
        const lead = first?.type === 'paragraph' ? first.children?.[0] : undefined;
        const marker =
          lead?.type === 'text' ? lead.value?.match(/^\[!([A-Z]+)\]\s*/) : null;
        if (marker && CALLOUT_KINDS.has(marker[1]) && lead && first) {
          lead.value = (lead.value ?? '').slice(marker[0].length);
          if (!lead.value) first.children?.shift();
          if (first.children?.length === 0) node.children?.shift();
          node.data = {
            hName: 'aside',
            hProperties: { dataCallout: marker[1].toLowerCase() },
          };
        }
      }

      walk(node);
      return node;
    };

    const walk = (parent: MdNode): void => {
      const children = parent.children;
      if (!children) return;
      const kept: MdNode[] = [];
      children.forEach((child, i) => {
        const next = children[i + 1];
        if (
          child.type === 'thematicBreak' &&
          next?.type === 'heading' &&
          next.depth === 2
        ) {
          return;
        }
        const replaced = visit(child);
        if (replaced !== null) kept.push(replaced);
      });
      parent.children = kept;
    };

    walk(tree);
  };
}
