import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { Th, Td, TABLE_CLASS, TABLE_BODY_CLASS, TH_CLASS, TD_CLASS } from './Table';

function renderCell(cell: React.ReactNode) {
  return render(
    <table>
      <tbody>
        <tr>{cell}</tr>
      </tbody>
    </table>,
  );
}

describe('Table chrome', () => {
  it('rules rows on the gray ramp, so the colour themes re-skin them', () => {
    for (const value of [TABLE_CLASS, TABLE_BODY_CLASS, TH_CLASS, TD_CLASS]) {
      expect(value).not.toMatch(/#[0-9a-f]{3,6}/i);
      expect(value).toMatch(/gray-/);
    }
  });

  it('gives the table and its body the same rules', () => {
    // A table that divides at one level and not the other draws a stray line
    // under the header, or none at all.
    expect(TABLE_CLASS).toContain(TABLE_BODY_CLASS);
  });

  it('renders Th with the shared header styling', () => {
    renderCell(<Th>Amount</Th>);
    const th = screen.getByText('Amount');
    expect(th.tagName).toBe('TH');
    expect(th.className).toContain('uppercase');
    expect(th.className).toContain('text-xs');
  });

  it('aligns left by default and right on request', () => {
    // `<th>` is centred by the UA stylesheet, so a numeric column that does
    // not say `right` lands in the middle of its cell.
    const { unmount } = renderCell(<Th>Name</Th>);
    expect(screen.getByText('Name').className).toContain('text-left');
    unmount();

    renderCell(<Th align="right">Balance</Th>);
    expect(screen.getByText('Balance').className).toContain('text-right');
  });

  it('renders Td with body styling and passes attributes through', () => {
    renderCell(<Td colSpan={3}>Nothing yet</Td>);
    const td = screen.getByText('Nothing yet');
    expect(td.tagName).toBe('TD');
    expect(td).toHaveAttribute('colspan', '3');
    expect(td.className).toContain('text-sm');
  });

  it('lets a call site override padding without losing the rest', () => {
    renderCell(<Th className="px-6">Wide</Th>);
    const th = screen.getByText('Wide');
    expect(th.className).toContain('px-6');
    expect(th.className).not.toContain('px-4');
    expect(th.className).toContain('uppercase');
  });
});
