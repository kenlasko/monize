'use client';

import { useTranslations } from 'next-intl';
import { CARD_CLASS } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ReportFavouriteButton } from './ReportFavouriteButton';
import type { ReportCatalogueEntry, ReportsCatalogueViewProps } from './reports-catalogue-view';

function Tile({
  entry,
  onOpen,
  onToggleFavourite,
}: { entry: ReportCatalogueEntry } & Pick<ReportsCatalogueViewProps, 'onOpen' | 'onToggleFavourite'>) {
  return (
    <li className="ui-rep-card-wrap relative" {...entry.tourAnchor}>
      <button
        type="button"
        onClick={() => onOpen(entry.report.id)}
        className={`${CARD_CLASS} ui-rep-card flex h-full w-full flex-col gap-3 p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
      >
        <span className="ui-rep-puck" aria-hidden="true">
          {entry.report.icon}
        </span>
        <span className="ui-rep-card-name">{entry.name}</span>
        <span className="ui-rep-card-desc">{entry.description}</span>
        <Badge variant="gray" className="mt-auto w-fit">
          {entry.categoryLabel}
        </Badge>
      </button>
      <ReportFavouriteButton
        favourite={entry.favourite}
        onToggle={(e) => onToggleFavourite(e, entry.report)}
        className="ui-rep-card-fav absolute right-3 top-3"
      />
    </li>
  );
}

/**
 * The reports index as colour blocks: the favourites together in one accent
 * block, then every other report as a white block with a round icon puck, a
 * heavy tight name and its section as a pill.
 */
export function ReportsCatalogueModern({ entries, onOpen, onToggleFavourite }: ReportsCatalogueViewProps) {
  const t = useTranslations('reports');
  const favourites = entries.filter((e) => e.favourite);
  const others = entries.filter((e) => !e.favourite);
  return (
    <div className="ui-rep-catalogue space-y-5">
      {favourites.length > 0 && (
        <section aria-labelledby="rep-favs" className="ui-block-accent ui-rep-favs rounded-(--ui-radius-card) p-5">
          <h2 id="rep-favs" className="ui-rep-favs-title">
            {t('detailHeader.favourites')}
          </h2>
          <ul className="ui-rep-grid mt-4">
            {favourites.map((entry) => (
              <Tile key={entry.report.id} entry={entry} onOpen={onOpen} onToggleFavourite={onToggleFavourite} />
            ))}
          </ul>
        </section>
      )}
      {others.length > 0 && (
        <ul className="ui-rep-grid" aria-label={t('page.title')}>
          {others.map((entry) => (
            <Tile key={entry.report.id} entry={entry} onOpen={onOpen} onToggleFavourite={onToggleFavourite} />
          ))}
        </ul>
      )}
    </div>
  );
}
