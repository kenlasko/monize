'use client';

import { getIconComponent } from '@/components/ui/IconPicker';
import { DensityLevel } from '@/hooks/useTableDensity';

interface CategoryPillProps {
  name: string;
  /** Effective colour (own or inherited); null renders the neutral pill. */
  color: string | null;
  /** Category icon name (categories.icon); null renders no glyph. */
  icon?: string | null;
  density: DensityLevel;
  title?: string;
  maxWidthClass?: string;
  /** Renders as a filter button when set, a plain chip otherwise. */
  onClick?: (e: React.MouseEvent) => void;
  /**
   * The Folio register's form: no filled capsule, a small square marker in the
   * category's colour ahead of plain ledger text. Folio is a printed ledger
   * (rules, small caps, no rounded chips), and a coloured pill is the one
   * element in a row that reads as an app widget rather than a line of print.
   * The icon is left out: the marker carries the colour, the name carries the rest.
   */
  ledger?: boolean;
}

/**
 * The register's category chip: the colour-mix pill plus the category's
 * optional icon, rendered the same way whether it is clickable (a filter
 * button) or plain. This used to be four near-identical inline copies in
 * `TransactionRow` -- and none of them drew the icon the schema had carried
 * for years.
 */
export function CategoryPill({
  name,
  color,
  icon,
  density,
  title,
  maxWidthClass = 'max-w-[160px]',
  onClick,
  ledger = false,
}: CategoryPillProps) {
  if (ledger) {
    const ledgerClass = `ui-register-cat inline-flex items-center gap-1.5 text-sm ${maxWidthClass}${
      onClick ? ' ui-register-cat-link' : ''
    }`;
    const ledgerBody = (
      <>
        <span
          aria-hidden
          className="ui-register-cat-mark"
          style={color ? { backgroundColor: color } : undefined}
        />
        <span className="truncate">{name}</span>
      </>
    );
    return onClick ? (
      <button onClick={onClick} className={ledgerClass} title={title ?? name}>
        {ledgerBody}
      </button>
    ) : (
      <span className={ledgerClass} title={title ?? name}>
        {ledgerBody}
      </span>
    );
  }
  const className = `inline-flex items-center gap-1 text-xs leading-5 font-semibold rounded-full ${maxWidthClass} ${
    density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'
  }${onClick ? ' hover:opacity-80 transition-opacity' : ''}`;
  const style = {
    backgroundColor: color
      ? `color-mix(in srgb, ${color} 15%, var(--category-bg-base, #e5e7eb))`
      : 'var(--category-bg-base, #e5e7eb)',
    color: color
      ? `color-mix(in srgb, ${color} 85%, var(--category-text-mix, #000))`
      : 'var(--category-text-base, #6b7280)',
  };
  const body = (
    <>
      {icon && (
        <span aria-hidden className="w-3 h-3 flex-shrink-0 [&>svg]:w-3 [&>svg]:h-3">
          {getIconComponent(icon)}
        </span>
      )}
      <span className="truncate">{name}</span>
    </>
  );

  if (onClick) {
    return (
      <button onClick={onClick} className={className} style={style} title={title ?? name}>
        {body}
      </button>
    );
  }
  return (
    <span className={className} style={style} title={title ?? name}>
      {body}
    </span>
  );
}
