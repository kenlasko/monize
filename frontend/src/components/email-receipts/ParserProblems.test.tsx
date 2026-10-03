import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@/test/render';
import { ParserProblems } from './ParserProblems';
import { PARSER_VALIDATION_CODES } from '@/lib/receipt-parser-form';

describe('ParserProblems', () => {
  it('says where each problem is in the words of the form and what is wrong', () => {
    render(
      <ParserProblems
        problems={[
          { path: 'total[0]', code: 'capture_missing' },
          { path: 'items.patterns[1]', code: 'capture_conflict' },
          { path: 'categoryRules[2].categoryId', code: 'invalid_uuid' },
          { path: 'categoryRules[0].match', code: 'too_long' },
          { path: 'orderId', code: 'too_many' },
          { path: 'items.startAfter', code: 'too_long' },
          { path: '', code: 'not_object' },
        ]}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Total patterns, line 1: is missing a capture this field needs')).toBeInTheDocument();
    expect(
      within(alert).getByText('Item patterns, line 2: captures both the line total and the unit price. Use one of them.'),
    ).toBeInTheDocument();
    expect(within(alert).getByText('Category rule 3, category: is not a valid category')).toBeInTheDocument();
    expect(within(alert).getByText('Category rule 1, pattern: is too long (at most 200 characters)')).toBeInTheDocument();
    expect(within(alert).getByText('Order number patterns: has too many entries (at most 10)')).toBeInTheDocument();
    expect(within(alert).getByText('Items start after: is too long (at most 100 characters)')).toBeInTheDocument();
    expect(within(alert).getByText('The definition: is not a valid definition')).toBeInTheDocument();
  });

  it('bounds the number of category rules by the rule limit, not the pattern limit', () => {
    render(<ParserProblems problems={[{ path: 'categoryRules', code: 'too_many' }]} />);
    expect(screen.getByText('Category rules: has too many entries (at most 50)')).toBeInTheDocument();
  });

  it('shows a path and a code this client has not heard of as they are, never drops them', () => {
    render(<ParserProblems problems={[{ path: 'somethingNew', code: 'brand_new_code' }]} />);
    expect(screen.getByText('somethingNew: brand_new_code')).toBeInTheDocument();
  });

  it('has a readable sentence for every code the server can report', () => {
    render(<ParserProblems problems={PARSER_VALIDATION_CODES.map((code) => ({ path: 'total', code }))} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(PARSER_VALIDATION_CODES.length);
    for (const item of items) {
      // A missing message would render its key (`codes.xyz`) or the bare code.
      expect(item.textContent).toMatch(/^Total patterns: .+ .+/);
      expect(item.textContent).not.toMatch(/codes\./);
    }
  });
});
