'use client';

import { useTranslations } from 'next-intl';
import type { ReportCategory } from '../report-definitions';
import { ReportFavouriteButton } from './ReportFavouriteButton';
import type { ReportCatalogueEntry, ReportsCatalogueViewProps } from './reports-catalogue-view';

function Section({
  title,
  entries,
  onOpen,
  onToggleFavourite,
  id,
}: {
  title: string;
  entries: ReportCatalogueEntry[];
  id: string;
} & Pick<ReportsCatalogueViewProps, 'onOpen' | 'onToggleFavourite'>) {
  return (
    <section aria-labelledby={id} className="ui-rep-section">
      <div className="ui-section-head flex items-baseline justify-between gap-3">
        <h2 id={id}>{title}</h2>
        <span className="ui-figure-label ui-rep-count">{String(entries.length).padStart(2, '0')}</span>
      </div>
      <ol className="ui-rep-list">
        {entries.map((entry, i) => (
          <li key={entry.report.id} className="ui-rep-row" {...entry.tourAnchor}>
            <button type="button" onClick={() => onOpen(entry.report.id)} className="ui-rep-row-open">
              <span className="ui-rep-no" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="ui-rep-row-text">
                <span className="ui-rep-row-name">{entry.name}</span>
                <span className="ui-rep-row-desc">{entry.description}</span>
              </span>
            </button>
            <ReportFavouriteButton
              favourite={entry.favourite}
              onToggle={(e) => onToggleFavourite(e, entry.report)}
              className="ui-rep-row-fav"
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The reports index as a table of contents: each section a serif heading on
 * an ink rule with its count, each report a numbered, hairline-ruled entry
 * (name over a line of description) with the favourite star at the margin.
 */
export function ReportsCatalogueFolio({
  entries,
  categories,
  groupBySection,
  categoryLabel,
  onOpen,
  onToggleFavourite,
}: ReportsCatalogueViewProps) {
  const t = useTranslations('reports');
  if (!groupBySection) {
    const first = entries[0]?.report.category;
    return (
      <div className="ui-rep-catalogue">
        {first && (
          <Section
            id="rep-sec-single"
            title={categoryLabel(first as ReportCategory)}
            entries={entries}
            onOpen={onOpen}
            onToggleFavourite={onToggleFavourite}
          />
        )}
      </div>
    );
  }
  const sections = categories
    .map((cat) => ({ cat, items: entries.filter((e) => e.report.category === cat) }))
    .filter((s) => s.items.length > 0);
  return (
    <div className="ui-rep-catalogue" aria-label={t('page.title')}>
      {sections.map(({ cat, items }) => (
        <Section
          key={cat}
          id={`rep-sec-${cat}`}
          title={categoryLabel(cat)}
          entries={items}
          onOpen={onOpen}
          onToggleFavourite={onToggleFavourite}
        />
      ))}
    </div>
  );
}
