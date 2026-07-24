import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render, screen } from '@/test/render';
import { WhatsNewModal } from './WhatsNewModal';
import type { ReleaseNotes } from '@/lib/whats-new';

const NOTES: ReleaseNotes = {
  version: '1.12.1',
  intro: 'Big release intro paragraph.',
  sections: [
    {
      heading: 'Loans',
      body: 'Loan section lead.',
      children: [{ heading: 'Goal seek', body: 'Goal seek detail.', children: [] }],
    },
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

describe('WhatsNewModal', () => {
  it('shows the title, version, intro, section headings and subheadings', () => {
    renderModal();

    expect(screen.getByText("What's New")).toBeInTheDocument();
    expect(screen.getByText('Version 1.12.1')).toBeInTheDocument();
    expect(screen.getByText('Big release intro paragraph.')).toBeInTheDocument();
    // Sections are expanded by default: headings, section bodies and subheading
    // titles are visible.
    expect(screen.getByText('Loans')).toBeInTheDocument();
    expect(screen.getByText('Loan section lead.')).toBeInTheDocument();
    expect(screen.getByText('Goal seek')).toBeInTheDocument();
    expect(screen.getByText('Bug Fixes')).toBeInTheDocument();
    // Subsection detail is collapsed by default.
    expect(screen.queryByText('Goal seek detail.')).not.toBeInTheDocument();
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
    // Only close affordances remain (the header X and the footer button).
    expect(
      screen.getAllByRole('button', { name: 'Close' }).length,
    ).toBeGreaterThan(0);
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
});
