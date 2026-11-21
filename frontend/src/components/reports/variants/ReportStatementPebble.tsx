'use client';

import { CARD_CLASS } from '@/components/ui/Card';
import { STATEMENT_TONE_CLASS, type ReportStatementViewProps } from './report-statement-view';

/**
 * A report's figures as colour blocks: the total in an ink block, with the
 * memo figures as pills under it, beside a white block of rows, each with a
 * round avatar (the series colour, else the line's gain or loss tone) and a big tight figure.
 */
export function ReportStatementPebble({ ariaLabel, lines, total, memo, showShare }: ReportStatementViewProps) {
  return (
    <section
      aria-label={ariaLabel}
      className={`ui-rep-statement grid gap-4 ${lines.length > 0 ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)]' : ''}`}
    >
      <div className="ui-invert ui-rep-st-hero rounded-(--ui-radius-card) bg-white p-6 text-gray-900 dark:bg-gray-800 dark:text-gray-100">
        <div className="ui-figure-label">{total.label}</div>
        <div className={`ui-rep-st-hero-fig mt-2 ${total.tone === 'loss' ? 'text-red-400' : ''}`}>
          {total.value}
        </div>
        {memo && memo.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-2">
            {memo.map((m) => (
              <li key={m.key} className="ui-rep-st-pill">
                <span>{m.label}</span>
                <strong className={m.tone === 'loss' ? 'text-red-400' : ''}>{m.value}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>
      {lines.length > 0 && (
        <ul className={`${CARD_CLASS} ui-rep-st-rows p-2 sm:p-3`}>
          {lines.map((line) => {
            const body = (
              <>
                <span
                  className="ui-rep-st-avatar"
                  data-tone={line.tone ?? 'plain'}
                  style={line.swatch ? { backgroundColor: line.swatch } : undefined}
                  aria-hidden="true"
                />
                <span className="ui-rep-st-name">{line.label}</span>
                {showShare && line.share && <span className="ui-rep-st-share">{line.share}</span>}
                <span className={`ui-rep-st-amount ${STATEMENT_TONE_CLASS[line.tone ?? 'plain']}`}>{line.value}</span>
              </>
            );
            return (
              <li key={line.key}>
                {line.onSelect ? (
                  <button type="button" onClick={line.onSelect} disabled={line.disabled} className="ui-rep-st-row">
                    {body}
                  </button>
                ) : (
                  <div className="ui-rep-st-row">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
