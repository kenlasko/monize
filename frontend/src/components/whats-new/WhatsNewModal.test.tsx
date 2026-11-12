import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render as rtlRender } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { render, screen } from '@/test/render';
import { ThemeProvider } from '@/contexts/ThemeContext';
import commonMessages from '@/i18n/messages/en/common.json';
import { WhatsNewModal } from './WhatsNewModal';
import type { ReleaseNotes } from '@/lib/whats-new';

const ENGLISH_ONLY = commonMessages.whatsNew.englishOnly;

const NOTES: ReleaseNotes = {
  version: '1.12.1',
  intro: 'Big release intro paragraph.',
  sections: [
    {
      heading: 'Loans',
      body: 'Loan section lead.',
      children: [{ heading: 'Goal seek', body: 'Goal seek detail.', children: [] }],
    },
    { heading: 'Reports', body: '- **One:** a.\n- **Two:** b.\n  - nested detail', children: [] },
    { heading: 'Bug Fixes', body: 'Fixed a thing.', children: [] },
  ],
  releaseUrl: 'https://github.com/kenlasko/monize/releases/tag/v1.12.1',
};

function renderModal(props: Partial<React.ComponentProps<typeof WhatsNewModal>> = {}) {
  return render(
    <WhatsNewModal
      isOpen
      notes={NOTES}
      authenticated
      onClose={vi.fn()}
      onShowNextLogin={vi.fn()}
      onDontShowAgain={vi.fn()}
      {...props}
    />,
  );
}

/**
 * The shared test render pins the locale to English; the English-only notice
 * depends on it, so these cases supply their own provider. English copy is
 * fine either way -- only the locale drives the notice.
 */
function renderInLocale(locale: string) {
  return rtlRender(
    <NextIntlClientProvider locale={locale} messages={{ common: commonMessages }}>
      <ThemeProvider>
        <WhatsNewModal
          isOpen
          notes={NOTES}
          authenticated={false}
          onClose={vi.fn()}
        />
      </ThemeProvider>
    </NextIntlClientProvider>,
  );
}

describe('WhatsNewModal', () => {
  it('shows the title, version, intro, section headings and subheadings', () => {
    renderModal();

    expect(screen.getByText("What's New")).toBeInTheDocument();
    // Once in the title's badge (hidden from the dialog's name) and once for
    // screen readers at the top of the body.
    expect(screen.getAllByText('Version 1.12.1')).toHaveLength(2);
    expect(screen.getByText('Big release intro paragraph.')).toBeInTheDocument();
    // The first feature section is expanded by default: its body and its
    // subheading titles are visible.
    expect(screen.getByText('Loans')).toBeInTheDocument();
    expect(screen.getByText('Loan section lead.')).toBeInTheDocument();
    expect(screen.getByText('Goal seek')).toBeInTheDocument();
    expect(screen.getByText('Bug Fixes')).toBeInTheDocument();
    // Subsection detail is collapsed by default.
    expect(screen.queryByText('Goal seek detail.')).not.toBeInTheDocument();
  });

  it('opens only the first feature section and leads with the features', () => {
    renderModal();

    // Reports is a feature, but not the first: collapsed.
    expect(screen.getByRole('button', { name: /Reports/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // Bug Fixes sits after the features under its own heading, collapsed.
    const group = screen.getByRole('heading', { name: 'Fixes and details' });
    const fixes = screen.getByRole('button', { name: 'Bug Fixes' });
    expect(fixes).toHaveAttribute('aria-expanded', 'false');
    expect(
      group.compareDocumentPosition(fixes) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText('Fixed a thing.')).not.toBeInTheDocument();
  });

  it('counts each feature section\'s top-level changes and subsections', () => {
    renderModal();

    // Loans: no bullets, one subsection. Reports: two bullets, the nested one
    // is detail of the second.
    expect(screen.getByText('1 change')).toBeInTheDocument();
    expect(screen.getByText('2 changes')).toBeInTheDocument();
  });

  it('leaves out the group heading when a release has only maintenance sections', () => {
    renderModal({
      notes: {
        ...NOTES,
        sections: [{ heading: 'Fixes', body: 'Fixed a thing.', children: [] }],
      },
    });

    expect(screen.queryByText('Fixes and details')).toBeNull();
    // With no feature to lead, the first section opens instead.
    expect(screen.getByText('Fixed a thing.')).toBeInTheDocument();
  });

  it('reveals a subheading detail when clicked', () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: /Goal seek/ }));
    expect(screen.getByText('Goal seek detail.')).toBeInTheDocument();
  });

  it('expands and collapses everything via the expand/collapse-all control', () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByText('Goal seek detail.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByText('Goal seek detail.')).not.toBeInTheDocument();
    // Collapse all also closes the sections, hiding their bodies.
    expect(screen.queryByText('Loan section lead.')).not.toBeInTheDocument();
  });

  it('links to the full release notes', () => {
    renderModal();

    const link = screen.getByRole('link', { name: 'View full release notes' });
    expect(link).toHaveAttribute('href', NOTES.releaseUrl);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('acknowledges the version with "Don\'t show this again"', () => {
    const onDontShowAgain = vi.fn();
    const onClose = vi.fn();
    renderModal({ onDontShowAgain, onClose });

    fireEvent.click(
      screen.getByRole('button', { name: "Don't show this again" }),
    );
    expect(onDontShowAgain).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('requests a reminder via "Show at next login" without acknowledging', () => {
    const onShowNextLogin = vi.fn();
    const onDontShowAgain = vi.fn();
    renderModal({ onShowNextLogin, onDontShowAgain });

    fireEvent.click(screen.getByRole('button', { name: 'Show at next login' }));
    expect(onShowNextLogin).toHaveBeenCalledTimes(1);
    expect(onDontShowAgain).not.toHaveBeenCalled();
  });

  it('hides the acknowledge actions for unauthenticated viewers', () => {
    renderModal({ authenticated: false, onDontShowAgain: undefined });

    expect(
      screen.queryByRole('button', { name: "Don't show this again" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Show at next login' }),
    ).not.toBeInTheDocument();
    // Only the footer's Close remains.
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
  });

  it('is named by its title, with Close in the button row and no X', () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    const dialog = screen.getByRole('dialog', { name: "What's New" });
    // One Close, beside the two acknowledgement choices, not a corner X.
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
    expect(dialog.querySelector('.border-t, .border-b')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows an unavailable message when there are no notes', () => {
    renderModal({ notes: null });
    expect(
      screen.getByText("Release notes for this version aren't available."),
    ).toBeInTheDocument();
  });

  it('offers guided tours when authenticated and a version is known', () => {
    renderModal({ currentVersion: '1.13.0' });
    expect(screen.getByText('Take a quick tour')).toBeInTheDocument();
  });

  it('omits the tour offer when no version is provided', () => {
    renderModal();
    expect(screen.queryByText('Take a quick tour')).toBeNull();
  });

  it('omits the tour offer for unauthenticated viewers', () => {
    renderModal({ authenticated: false, currentVersion: '1.13.0' });
    expect(screen.queryByText('Take a quick tour')).toBeNull();
  });

  it('says the notes are English-only when the app is in another language', () => {
    renderInLocale('pl');
    expect(screen.getByText(ENGLISH_ONLY)).toBeInTheDocument();
  });

  it('leaves the notice out for English readers', () => {
    renderInLocale('en-GB');
    expect(screen.queryByText(ENGLISH_ONLY)).toBeNull();
  });
});
