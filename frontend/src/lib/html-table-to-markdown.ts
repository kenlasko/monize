/**
 * Convert HTML tables in a clipboard `text/html` fragment to GitHub-flavoured
 * Markdown tables. Used by the chat's rich paste: pasting a table from a web
 * page drops a readable Markdown table into the prompt instead of the browser's
 * flattened plain text. Returns null when there's no table (caller falls back
 * to the default plain-text paste). Client-only (uses DOMParser).
 */
export function htmlTablesToMarkdown(html: string): string | null {
  if (typeof window === 'undefined' || !html) return null;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }

  const tables = Array.from(doc.querySelectorAll('table'));
  if (tables.length === 0) return null;

  const blocks = tables.map(tableToMarkdown).filter((b): b is string => !!b);
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

function cellText(cell: Element): string {
  // Collapse whitespace and escape so the cell can't break the table.
  // Backslashes are escaped first so an input backslash can't combine with the
  // pipe-escaping below to alter the rendered text.
  return (cell.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|');
}

function tableToMarkdown(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr'))
    .map((tr) => Array.from(tr.querySelectorAll('th,td')).map(cellText))
    .filter((cells) => cells.length > 0);

  if (rows.length === 0) return '';

  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]): string[] => {
    const c = [...r];
    while (c.length < cols) c.push('');
    return c;
  };
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;

  const header = pad(rows[0]);
  const separator = header.map(() => '---');
  const body = rows.slice(1).map(pad);

  return [line(header), line(separator), ...body.map(line)].join('\n');
}
