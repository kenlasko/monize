'use client';

import type { ReactNode } from 'react';
import { CategoryGlyph } from '@/components/categories/CategoryGlyph';
import type { Category } from '@/types/category';

interface CategoryPickerIconProps {
  category: Pick<Category, 'icon' | 'color' | 'effectiveIcon' | 'effectiveColor'>;
  /** The square the glyph is centred in, so icons and dots line up. */
  size?: number;
}

/**
 * The mark a category row carries in a picker: its effective icon, else its
 * colour dot, centred in a fixed square so icons and dots line up. Inherited
 * values are drawn as the category's own, the way the command palette draws
 * them: in a picker the mark is a cue to find the row by, not a statement about
 * where it came from. Pickers should go through `categoryPickerIcon`, which
 * gives a category with neither no mark at all, so its row has no blank slot.
 */
export function CategoryPickerIcon({ category, size = 20 }: CategoryPickerIconProps) {
  const icon = category.effectiveIcon ?? category.icon;
  const color = category.effectiveColor ?? category.color;
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center"
    >
      <CategoryGlyph icon={icon} color={color} size={icon ? size - 4 : Math.round(size / 2)} />
    </span>
  );
}

type IconSource = CategoryPickerIconProps['category'] & { id: string };

/**
 * The `icon` for a category's picker row: its `CategoryPickerIcon`, or
 * `undefined` when it has no icon or colour anywhere up its ancestry. The
 * pickers leave no space for an option whose `icon` is unset, so such a row's
 * name starts where the slot would have been instead of after a blank square.
 */
export function categoryPickerIcon(
  category: CategoryPickerIconProps['category'],
): ReactNode | undefined {
  const icon = category.effectiveIcon ?? category.icon;
  const color = category.effectiveColor ?? category.color;
  return icon || color ? <CategoryPickerIcon category={category} /> : undefined;
}

/**
 * `options` with each category row carrying its picker icon, for an option list
 * built elsewhere (`getCategorySelectOptions`, `buildCategoryFilterOptions`)
 * that knows only ids and labels. A hierarchical filter list is decorated all
 * the way down its `children`. A row whose value is not a category (a
 * placeholder, "Uncategorized"), or a category with no icon or colour, is left
 * without one.
 */
export function withCategoryIcons<T extends { value: string; children?: unknown[] }>(
  options: readonly T[],
  categories: readonly IconSource[],
): (T & { icon?: ReactNode })[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const decorate = (list: readonly T[]): (T & { icon?: ReactNode })[] =>
    list.map((option) => {
      const category = byId.get(option.value);
      const children = option.children ? { children: decorate(option.children as T[]) } : {};
      const icon = category ? categoryPickerIcon(category) : undefined;
      return icon ? { ...option, ...children, icon } : { ...option, ...children };
    });
  return decorate(options);
}
