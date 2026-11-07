import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { ReleaseNotesMarkdown } from './ReleaseNotesMarkdown';
import { useHelpStore } from '@/store/helpStore';

beforeEach(() => {
  useHelpStore.setState(useHelpStore.getInitialState(), true);
});

describe('ReleaseNotesMarkdown', () => {
  it('renders nothing for empty content', () => {
    const { container } = render(<ReleaseNotesMarkdown content="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links the issue references the notes credit changes with', () => {
    render(<ReleaseNotesMarkdown content="Foreign currency landed. (#931, #933)" />);

    const first = screen.getByRole('link', { name: '#931' });
    expect(first).toHaveAttribute(
      'href',
      'https://github.com/kenlasko/monize/issues/931',
    );
    expect(first).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: '#933' })).toHaveAttribute(
      'href',
      'https://github.com/kenlasko/monize/issues/933',
    );
  });

  it('leaves references inside code spans as text', () => {
    render(<ReleaseNotesMarkdown content="Run `git log --grep #931` first." />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('opens a guide link in the help panel on a plain click', () => {
    useHelpStore.getState().setGuideAvailable(true);
    render(
      <ReleaseNotesMarkdown content="See [Budgets](https://www.monize.net/docs/budgets)." />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Budgets' }));
    expect(useHelpStore.getState().open).toBe(true);
    expect(useHelpStore.getState().history).toEqual([{ page: 'budgets' }]);
  });

  it('leaves a modified click on a guide link to the browser', () => {
    useHelpStore.getState().setGuideAvailable(true);
    render(
      <ReleaseNotesMarkdown content="See [Budgets](https://www.monize.net/docs/budgets)." />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Budgets' }), { ctrlKey: true });
    expect(useHelpStore.getState().open).toBe(false);
  });

  it('leaves a non-guide link to the browser', () => {
    useHelpStore.getState().setGuideAvailable(true);
    render(
      <ReleaseNotesMarkdown content="See [GitHub](https://github.com/kenlasko/monize)." />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'GitHub' }));
    expect(useHelpStore.getState().open).toBe(false);
  });
});
