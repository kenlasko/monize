import { describe, it, expect } from 'vitest';
import {
  RELEASE_1_13_FOREIGN_CURRENCY_TOUR,
  RELEASE_1_13_TOURS,
} from './release-1.13.0';
import { TOUR_ANCHORS } from '../anchors';
import { getReleaseTours } from '../registry';
import type { TourAnchorId } from '../anchors';

const tour = RELEASE_1_13_FOREIGN_CURRENCY_TOUR;
const ANCHOR_VALUES = new Set<TourAnchorId>(Object.values(TOUR_ANCHORS));

describe('foreign-currency release tour', () => {
  it('is a 1.13 release tour registered under a stable id', () => {
    expect(tour.id).toBe('release-1.13.0/foreign-currency');
    expect(tour.version).toBe('1.13');
    expect(tour.area).toBe('transactions');
    expect(tour.i18nPrefix).toBe('release.v1_13_0.foreignCurrency');
    expect(RELEASE_1_13_TOURS).toContain(tour);
    expect(getReleaseTours('1.13.4').map((t) => t.id)).toContain(tour.id);
  });

  it('walks the fee -> transaction -> detail -> report path in order', () => {
    expect(tour.steps.map((s) => s.id)).toEqual([
      'welcome',
      'openAccountEdit',
      'fxFeePercent',
      'closeAccountForm',
      'newTransaction',
      'entryCurrency',
      'closeTransactionForm',
      'openAccountDetail',
      'fxSection',
      'report',
      'finish',
    ]);
  });

  it('only anchors on ids that exist in TOUR_ANCHORS', () => {
    for (const step of tour.steps) {
      if (step.anchorId !== null) {
        expect(ANCHOR_VALUES.has(step.anchorId)).toBe(true);
      }
    }
  });

  it('opens and closes the account edit form around the fee field', () => {
    const openEdit = tour.steps.find((s) => s.id === 'openAccountEdit')!;
    expect(openEdit.advance).toEqual({
      type: 'appear',
      anchorId: TOUR_ANCHORS.accountFxFeePercent,
    });

    const fee = tour.steps.find((s) => s.id === 'fxFeePercent')!;
    expect(fee.anchorId).toBe(TOUR_ANCHORS.accountFxFeePercent);

    const closeForm = tour.steps.find((s) => s.id === 'closeAccountForm')!;
    expect(closeForm.advance).toEqual({
      type: 'disappear',
      anchorId: TOUR_ANCHORS.accountFxFeePercent,
    });
  });

  it('opens the transaction form and points at the entry-currency picker', () => {
    const newTxn = tour.steps.find((s) => s.id === 'newTransaction')!;
    expect(newTxn.anchorId).toBe(TOUR_ANCHORS.transactionsNewButton);
    expect(newTxn.advance).toEqual({
      type: 'appear',
      anchorId: TOUR_ANCHORS.transactionForm,
    });

    const currency = tour.steps.find((s) => s.id === 'entryCurrency')!;
    expect(currency.anchorId).toBe(TOUR_ANCHORS.transactionCurrencyField);
    // Interactive: advances only once the user actually selects a foreign
    // currency (the converted-amount field mounts), not on a passive Next.
    expect(currency.advance).toEqual({
      type: 'appear',
      anchorId: TOUR_ANCHORS.transactionConvertedAmount,
    });

    const closeTxn = tour.steps.find((s) => s.id === 'closeTransactionForm')!;
    expect(closeTxn.advance).toEqual({
      type: 'disappear',
      anchorId: TOUR_ANCHORS.transactionForm,
    });
  });

  it('routes to a dynamic account detail page then highlights its fx section', () => {
    const openDetail = tour.steps.find((s) => s.id === 'openAccountDetail')!;
    expect(openDetail.advance).toEqual({ type: 'route', route: '/accounts/' });

    const section = tour.steps.find((s) => s.id === 'fxSection')!;
    expect(section.routeMatch).toBe('/accounts/');
    expect(section.anchorId).toBe(TOUR_ANCHORS.foreignCurrencyFees);
  });

  it('ends on the cross-account report card', () => {
    const report = tour.steps.find((s) => s.id === 'report')!;
    expect(report.route).toBe('/reports');
    expect(report.anchorId).toBe(TOUR_ANCHORS.reportForeignCurrencyFees);
  });
});
