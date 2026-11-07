import { describe, expect, it } from 'vitest';
import { DOCS_LINKS } from './docs-links';
import { HELP_TOURS, tourIdForHelpPage } from './help-tours';
import { ALL_TOURS, getTourById } from './tours/registry';

describe('HELP_TOURS', () => {
  it('maps every destination to a tour that exists', () => {
    for (const [link, tourId] of Object.entries(HELP_TOURS)) {
      expect(getTourById(tourId), `${link} -> ${tourId}`).toBeDefined();
    }
  });

  it('keys every entry with a real guide destination', () => {
    for (const link of Object.keys(HELP_TOURS)) {
      expect(Object.keys(DOCS_LINKS)).toContain(link);
    }
  });
});

describe('every tour.docs', () => {
  it('names a real guide destination', () => {
    for (const tour of ALL_TOURS) {
      if (tour.docs === undefined) continue;
      expect(Object.keys(DOCS_LINKS), tour.id).toContain(tour.docs);
    }
  });
});

describe('tourIdForHelpPage', () => {
  it('resolves the dashboard tour from its help page', () => {
    expect(tourIdForHelpPage(DOCS_LINKS.dashboard.page)).toBe('intro/basics');
  });

  it('resolves the email receipts tour from its help page', () => {
    expect(tourIdForHelpPage(DOCS_LINKS.emailReceipts.page)).toBe(
      'email-receipts/basics',
    );
  });

  it('returns undefined for a page with no mapped tour', () => {
    expect(tourIdForHelpPage('reports')).toBeUndefined();
  });
});
