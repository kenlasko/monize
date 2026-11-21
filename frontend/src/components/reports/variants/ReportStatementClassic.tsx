'use client';

import { useTranslations } from 'next-intl';
import { STATEMENT_TONE_CLASS, type ReportStatementViewProps } from './report-statement-view';

/**
 * A report's figures as a financial statement: small-capital column heads on
 * an ink rule, one ruled line per item with the figure right-aligned in a
 * mono face, the total under a double rule, memo figures beneath.
 */
export function ReportStatementClassic({ ariaLabel, lines, total, memo, showShare }: ReportStatementViewProps) {
  const t = useTranslations('reports');
  return (
    <section aria-label={ariaLabel} className="ui-rep-statement">
      <table>
        {lines.length > 0 && (
        <thead>
          <tr>
            <th scope="col">{t('statement.item')}</th>
            {showShare && (
              <th scope="col" className="ui-rep-st-num">
                {t('statement.share')}
              </th>
            )}
            <th scope="col" className="ui-rep-st-num">
              {t('statement.amount')}
            </th>
          </tr>
        </thead>
        )}
        <tbody>
          {lines.map((line) => (
            <tr key={line.key}>
              <td>
                {line.swatch && (
                  <span className="ui-rep-st-swatch" style={{ backgroundColor: line.swatch }} aria-hidden="true" />
                )}
                {line.onSelect ? (
                  <button type="button" onClick={line.onSelect} disabled={line.disabled} className="ui-rep-st-link">
                    {line.label}
                  </button>
                ) : (
                  line.label
                )}
              </td>
              {showShare && <td className="ui-rep-st-num">{line.share}</td>}
              <td className={`ui-rep-st-num ${STATEMENT_TONE_CLASS[line.tone ?? 'plain']}`}>{line.value}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="ui-rep-st-total">
            <th scope="row">{total.label}</th>
            {showShare && <td />}
            <td className={`ui-rep-st-num ${STATEMENT_TONE_CLASS[total.tone ?? 'plain']}`}>{total.value}</td>
          </tr>
          {memo?.map((m) => (
            <tr key={m.key} className="ui-rep-st-memo">
              <th scope="row">{m.label}</th>
              {showShare && <td />}
              <td className={`ui-rep-st-num ${STATEMENT_TONE_CLASS[m.tone ?? 'plain']}`}>{m.value}</td>
            </tr>
          ))}
        </tfoot>
      </table>
    </section>
  );
}
