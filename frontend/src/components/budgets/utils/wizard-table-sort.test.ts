import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WIZARD_SORT,
  compareCategoryPaths,
  nextWizardSort,
  sortWizardRows,
  type WizardSortAccessors,
} from './wizard-table-sort';

interface Row {
  name: string;
  median: number;
  amount: number | null;
}

const accessors: WizardSortAccessors<Row> = {
  name: (r) => r.name,
  median: (r) => r.median,
  amount: (r) => r.amount,
};

const row = (name: string, median = 0, amount: number | null = null): Row => ({ name, median, amount });
const names = (rows: readonly Row[]) => rows.map((r) => r.name);

describe('compareCategoryPaths', () => {
  const mixed = ['Taxes: Property', 'Taxes Owing', 'Auto: Fuel', 'Taxes', 'Taxes: Federal', 'Auto'];

  it('keeps every subcategory directly under its parent', () => {
    // A plain localeCompare puts "Taxes Owing" between "Taxes" and its children.
    expect([...mixed].sort((a, b) => a.localeCompare(b))).toEqual([
      'Auto',
      'Auto: Fuel',
      'Taxes',
      'Taxes Owing',
      'Taxes: Federal',
      'Taxes: Property',
    ]);
    expect([...mixed].sort((a, b) => compareCategoryPaths(a, b))).toEqual([
      'Auto',
      'Auto: Fuel',
      'Taxes',
      'Taxes: Federal',
      'Taxes: Property',
      'Taxes Owing',
    ]);
  });

  it('reverses parents and children descending, the parent still leading its group', () => {
    expect([...mixed].sort((a, b) => compareCategoryPaths(a, b, 'desc'))).toEqual([
      'Taxes Owing',
      'Taxes',
      'Taxes: Property',
      'Taxes: Federal',
      'Auto',
      'Auto: Fuel',
    ]);
  });

  it('groups children whose parent has no row of its own', () => {
    const sorted = ['Taxes: Property', 'Taxes Owing', 'Taxes: Federal'].sort((a, b) => compareCategoryPaths(a, b));
    expect(sorted).toEqual(['Taxes: Federal', 'Taxes: Property', 'Taxes Owing']);
  });
});

describe('nextWizardSort', () => {
  it('starts a new column ascending and flips the active one', () => {
    const name = nextWizardSort(DEFAULT_WIZARD_SORT, 'name');
    expect(name).toEqual({ field: 'name', direction: 'asc' });
    expect(nextWizardSort(name, 'name')).toEqual({ field: 'name', direction: 'desc' });
    expect(nextWizardSort({ field: 'name', direction: 'desc' }, 'amount')).toEqual({ field: 'amount', direction: 'asc' });
  });
});

describe('sortWizardRows', () => {
  const rows = [row('Groceries', 400, 450), row('Dining', 200, null), row('Auto: Fuel', 150, 150), row('Auto', 400, 50)];

  it('returns the rows untouched under the default order', () => {
    expect(sortWizardRows(rows, DEFAULT_WIZARD_SORT, accessors)).toBe(rows);
  });

  it('sorts by name along the category path', () => {
    expect(names(sortWizardRows(rows, { field: 'name', direction: 'asc' }, accessors))).toEqual([
      'Auto',
      'Auto: Fuel',
      'Dining',
      'Groceries',
    ]);
  });

  it('sorts by median both ways, ties broken by name', () => {
    expect(names(sortWizardRows(rows, { field: 'median', direction: 'asc' }, accessors))).toEqual([
      'Auto: Fuel',
      'Dining',
      'Auto',
      'Groceries',
    ]);
    expect(names(sortWizardRows(rows, { field: 'median', direction: 'desc' }, accessors))).toEqual([
      'Auto',
      'Groceries',
      'Dining',
      'Auto: Fuel',
    ]);
  });

  it('sorts by amount with unselected rows last in either direction', () => {
    expect(names(sortWizardRows(rows, { field: 'amount', direction: 'asc' }, accessors))).toEqual([
      'Auto',
      'Auto: Fuel',
      'Groceries',
      'Dining',
    ]);
    expect(names(sortWizardRows(rows, { field: 'amount', direction: 'desc' }, accessors))).toEqual([
      'Groceries',
      'Auto: Fuel',
      'Auto',
      'Dining',
    ]);
  });

  it('does not mutate its input', () => {
    const before = names(rows);
    sortWizardRows(rows, { field: 'amount', direction: 'desc' }, accessors);
    expect(names(rows)).toEqual(before);
  });
});
