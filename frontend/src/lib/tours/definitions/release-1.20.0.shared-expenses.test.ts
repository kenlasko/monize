import { describe, expect, it } from 'vitest';
import { SHARED_EXPENSES_TOUR as tour } from './release-1.20.0.shared-expenses';
import { getReleaseTours, getTourById } from '../registry';
import { backTargetIndex, isStepReachable } from '../navigation';
import { isTourOfferable } from '../requirements';

describe('shared expenses walkthrough', () => {
  it('offers the release tour to an owner with no personal accounts', () => {
    expect(getReleaseTours('1.20.0')).toContain(tour);
    expect(getTourById(tour.id)).toBe(tour);
    const requirements = {
      ownerView: true,
      accountsExist: false,
      transactionEntry: false,
      securitiesExist: false,
    };
    expect(isTourOfferable(tour, requirements)).toBe(true);
    expect(isTourOfferable(tour, { ...requirements, ownerView: false })).toBe(false);
    expect(isTourOfferable(tour, null)).toBe(false);
  });

  it('can finish and go back after group selection is skipped', () => {
    const selection = tour.steps.findIndex((step) => step.id === 'chooseGroup');
    const done = tour.steps.length - 1;
    const details = tour.steps.slice(selection + 1, done);
    expect(details.length).toBeGreaterThan(0);
    for (const step of details) {
      expect(isStepReachable(step, '/shared-expenses')).toBe(false);
      expect(isStepReachable(step, '/shared-expenses/selected-group')).toBe(true);
    }
    expect(isStepReachable(tour.steps[done], '/shared-expenses')).toBe(true);
    expect(backTargetIndex(tour.steps, done, '/shared-expenses')).toBe(selection);
  });

  it('leaves a reachable phone path without the desktop Tools anchor', () => {
    const phone = tour.steps.filter((step) => !step.skipOnMobile);
    expect(phone.some((step) => step.openToolsMenu)).toBe(false);
    const selection = phone.findIndex((step) => step.id === 'chooseGroup');
    for (const step of phone.slice(0, selection + 1)) {
      expect(isStepReachable(step, '/settings/tours')).toBe(true);
    }
    expect(phone[selection].advance).toEqual({
      type: 'route',
      route: '/shared-expenses/',
    });
  });
});
