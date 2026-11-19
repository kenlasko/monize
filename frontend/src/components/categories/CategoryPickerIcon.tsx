'use client';

import type { ReactNode } from 'react';
import { CategoryGlyph } from '@/components/categories/CategoryGlyph';
import type { Category } from '@/types/category';

interface CategoryPickerIconProps {
  category: Pick<Category, 'icon' | 'color' | 'effectiveIcon' | 'effectiveColor'>;
  /** The square the glyph is centred in, so rows without one still line up. */
  size?: number;
}

/**
 * The mark a category row carries in a picker: its effective icon, else its
 * colour dot, in a fixed square so a category with neither leaves its name in
 * the same column as the rest. Inherited values are drawn as the category's own,
 * the way the command palette draws them: in a picker the mark is a cue to
 * find the row by, not a statement about where it came from.
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
 * `options` with each category row carrying its picker icon, for an option list
 * built elsewhere (`getCategorySelectOptions`, `buildCategoryFilterOptions`)
 * that knows only ids and labels. A hierarchical filter list is decorated all
 * the way down its `children`. A row whose value is not a category (a
 * placeholder, "Uncategorized") is left without one.
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
      return category
        ? { ...option, ...children, icon: <CategoryPickerIcon category={category} /> }
        : { ...option, ...children };
    });
  return decorate(options);
}
