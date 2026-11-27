'use client';

import { type CategoryType, categoryTypeOf } from '@/lib/category-type';
import { useContext } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EntitySwitcher } from '@/components/ui/EntitySwitcher';
import {
  CollapsingTitleContext,
  useCollapsingHeaderTitle,
} from '@/hooks/useCollapsingHeaderTitle';
import { useDateFormat } from '@/hooks/useDateFormat';
import { parseLocalDate } from '@/lib/utils';
import type { Category } from '@/types/category';
import { CategoryGlyph } from '@/components/categories/CategoryGlyph';
import { useCategorySwitcher } from './CategorySwitcher';

interface CategoryDetailHeaderProps {
  category: Category;
  /**
   * The parent's name, resolved by the page from its category list (the
   * detail payload does not load the parent relation). Null for a top-level
   * category.
   */
  parentName: string | null;
  /**
   * Transactions can predate the category record (imports assign them to a
   * category created afterwards), so "Category since" is the earlier of the
   * first transaction and the record's creation.
   */
  firstTransactionDate: string | null;
  onBack: () => void;
  onViewTransactions: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** Categories the caret beside the name can jump to. */
  categories: readonly Category[];
}

/**
 * The identity block: which category this is and the actions on it. Parent,
 * description and dates live in the Key information card below, so the header
 * stays one line -- the same division the payee detail header settled on.
 *
 * A system category gets no Edit or Delete: the backend refuses both, and a
 * button whose action can only fail is worse than none.
 */
export function CategoryDetailHeader({
  category,
  parentName,
  firstTransactionDate,
  onBack,
  onViewTransactions,
  onEdit,
  onDelete,
  categories,
}: CategoryDetailHeaderProps) {
  const t = useTranslations('categoryDetail');
  const typePill = (type: CategoryType) => {
    switch (type) {
      case 'income':
        return t('header.incomePill');
      case 'transfer':
        return t('header.transferPill');
      default:
        return t('header.expensePill');
    }
  };
  const tc = useTranslations('categories');
  const switcher = useCategorySwitcher(category.id, categories);
  const { formatDate } = useDateFormat();

  // The user's own colour and icon, or the nearest ancestor's; never themed.
  const swatchColor = category.effectiveColor ?? category.color;
  const glyphIcon = category.effectiveIcon ?? category.icon;

  // The title carries the same hierarchical label every category picker uses:
  // "Parent: Child" for a subcategory, the bare name for a top-level one. A
  // bare "Fees" as the page title would not say which Fees this is.
  const title = parentName ? `${parentName}: ${category.name}` : category.name;

  // Below `xl`, once the name scrolls behind the app header, the header reads
  // "Categories - <this category>" and carries the same caret.
  const collapses = useContext(CollapsingTitleContext);
  const titleRef = useCollapsingHeaderTitle<HTMLHeadingElement>(
    collapses ? { title: tc('page.title'), context: title, switcher } : null,
  );

  // Compare calendar days (parseLocalDate drops the time), matching what
  // formatDate renders.
  const sinceDate =
    firstTransactionDate &&
    parseLocalDate(firstTransactionDate) < parseLocalDate(category.createdAt)
      ? firstTransactionDate
      : category.createdAt;

  return (
    <div className="ui-detail-header mb-6">
      <button
        type="button"
        onClick={onBack}
        className="ui-detail-back mb-2 -ml-1 inline-flex items-center gap-1 rounded text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
        {t('backToCategories')}
      </button>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <CategoryGlyph
              icon={glyphIcon}
              color={swatchColor}
              inherited={!category.icon && !category.color}
              size={20}
            />
            <h1 ref={titleRef} className="ui-detail-title truncate text-2xl font-bold text-gray-900 dark:text-gray-100">
              {title}
            </h1>
            {/* Jump straight to another category instead of going back to the
                list and clicking again. */}
            <EntitySwitcher {...switcher} />
          </div>

          <Badge className="ui-detail-pill">
            {typePill(categoryTypeOf(category))}
          </Badge>
          {category.isSystem && (
            <Badge className="ui-detail-pill">
              {t('header.systemBadge')}
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onViewTransactions}>
            {t('header.viewTransactions')}
          </Button>
          {!category.isSystem && (
            <>
              <Button variant="outline" size="sm" onClick={onEdit}>
                {t('header.edit')}
              </Button>
              <Button variant="outline" size="sm" onClick={onDelete}>
                {t('header.delete')}
              </Button>
            </>
          )}
        </div>
      </div>

      <p className="ui-detail-meta mt-1 text-sm text-gray-500 dark:text-gray-400">
        {t('header.since', { date: formatDate(sinceDate) })}
      </p>
    </div>
  );
}
