'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import type { CollapsedHeaderSwitcher } from '@/store/mobileChromeStore';
import { buildCategoryTree } from '@/lib/categoryUtils';
import type { Category } from '@/types/category';
import { categoryPickerIcon } from '@/components/categories/CategoryPickerIcon';

/**
 * The caret beside the category's name that jumps straight to another one,
 * without going back to the list and clicking again.
 *
 * The list is the same one the transaction form's Category dropdown offers:
 * every category in tree order, a child labelled "Parent: Child" and a
 * top-level category by its bare name -- and every row, parents included, is
 * selectable. A bare leaf name would be ambiguous (several parents can own a
 * "Fees"), and a differently-shaped list here would make the same picker read
 * two ways in one app. The filter matches the full hierarchical label.
 * Categories have no inactive state, so every one is a destination.
 *
 * Picking a category navigates, and the route is built here, as the report
 * switcher does. Returns `EntitySwitcher`'s props, memoized, so the header
 * draws the caret with `<EntitySwitcher {...switcher} />` and hands the very
 * same menu to the app header's collapsed title.
 *
 * @param categories Categories to switch between. Empty until the list has loaded.
 */
export function useCategorySwitcher(
  currentId: string,
  categories: readonly Category[],
): CollapsedHeaderSwitcher {
  const t = useTranslations('categoryDetail');
  const router = useRouter();

  const items = useMemo<EntitySwitcherItem[]>(() => {
    const byId = new Map(categories.map((c) => [c.id, c]));
    // Tree order (each parent followed by its children, alphabetical per
    // level), exactly as the transaction form builds its category options.
    return buildCategoryTree([...categories]).map(({ category }) => {
      const parent = category.parentId ? byId.get(category.parentId) : null;
      const label = parent ? `${parent.name}: ${category.name}` : category.name;
      return {
        id: category.id,
        primary: label,
        searchText: label,
        icon: categoryPickerIcon(category),
      };
    });
  }, [categories]);

  return useMemo(
    () => ({
      currentId,
      items,
      onSelect: (id: string) => router.push(`/categories/${id}`),
      triggerLabel: t('header.switchCategory'),
      filterPlaceholder: t('header.switchPlaceholder'),
      noMatchesLabel: t('header.switchNoMatches'),
    }),
    [currentId, items, router, t],
  );
}
