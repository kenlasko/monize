import { describe, it, expect } from 'vitest';
import { htmlTablesToMarkdown } from './html-table-to-markdown';

describe('htmlTablesToMarkdown', () => {
  it('returns null when there is no table', () => {
    expect(htmlTablesToMarkdown('<p>hello <b>world</b></p>')).toBeNull();
    expect(htmlTablesToMarkdown('')).toBeNull();
  });

  it('converts a simple table to a GFM markdown table', () => {
    const html =
      '<table><tr><th>Date</th><th>Amount</th></tr>' +
      '<tr><td>2026-01-01</td><td>10.50</td></tr></table>';
    expect(htmlTablesToMarkdown(html)).toBe(
      ['| Date | Amount |', '| --- | --- |', '| 2026-01-01 | 10.50 |'].join(
        '\n',
      ),
    );
  });

  it('escapes pipes and collapses whitespace in cells', () => {
    const html =
      '<table><tr><td>a | b</td><td>  c\n  d  </td></tr></table>';
    expect(htmlTablesToMarkdown(html)).toBe(
      ['| a \\| b | c d |', '| --- | --- |'].join('\n'),
    );
  });

  it('escapes backslashes before pipes so input is preserved unambiguously', () => {
    const html = '<table><tr><td>a\\</td><td>b\\|c</td></tr></table>';
    expect(htmlTablesToMarkdown(html)).toBe(
      ['| a\\\\ | b\\\\\\|c |', '| --- | --- |'].join('\n'),
    );
  });

  it('pads short rows to the widest row', () => {
    const html =
      '<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td></tr></table>';
    const md = htmlTablesToMarkdown(html);
    expect(md).toContain('| A | B | C |');
    expect(md).toContain('| 1 |  |  |');
  });

  it('converts multiple tables, separated by a blank line', () => {
    const html =
      '<table><tr><td>x</td></tr></table><table><tr><td>y</td></tr></table>';
    expect(htmlTablesToMarkdown(html)).toBe(
      '| x |\n| --- |\n\n| y |\n| --- |',
    );
  });
});
