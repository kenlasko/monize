/**
 * Column sort indicator for table headers.
 * Shows ↕ when unsorted, ↑ for ascending, ↓ for descending.
 */
export function SortIcon<F extends string>({
  field,
  sortField,
  sortDirection,
}: {
  field: F;
  sortField: F;
  sortDirection: 'asc' | 'desc';
}) {
  if (sortField !== field) {
    return <span className="ml-1 text-gray-300 dark:text-gray-600">↕</span>;
  }
  return <span className="ml-1">{sortDirection === 'asc' ? '↑' : '↓'}</span>;
}
