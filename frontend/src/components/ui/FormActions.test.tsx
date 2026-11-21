import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { FormActions } from './FormActions';

describe('FormActions', () => {
  it('renders Cancel and Save buttons when onCancel is provided', () => {
    const onCancel = vi.fn();
    render(<FormActions onCancel={onCancel} />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('does not render Cancel button when onCancel is not provided', () => {
    render(<FormActions />);
    expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('calls onCancel when Cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<FormActions onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('uses custom submitLabel', () => {
    render(<FormActions submitLabel="Create Account" />);
    expect(screen.getByText('Create Account')).toBeInTheDocument();
  });

  it('disables Cancel when isSubmitting is true', () => {
    const onCancel = vi.fn();
    render(<FormActions onCancel={onCancel} isSubmitting={true} />);
    expect(screen.getByText('Cancel').closest('button')).toBeDisabled();
  });

  it('disables submit button when submitDisabled is true', () => {
    render(<FormActions submitDisabled={true} />);
    expect(screen.getByText('Save').closest('button')).toBeDisabled();
  });

  it('applies custom className', () => {
    const { container } = render(<FormActions className="custom-class" />);
    expect(container.querySelector('.custom-class')).toBeInTheDocument();
  });

  it('wraps only the buttons when anchorProps is given', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <FormActions
        onCancel={onCancel}
        anchorProps={{ 'data-tour-id': 'transaction-form-actions' }}
      />,
    );
    const anchor = container.querySelector(
      '[data-tour-id="transaction-form-actions"]',
    )!;
    // A guided tour spotlights this element, so it must hold the button pair
    // and nothing else -- not the full-width row around them.
    expect(anchor).toBeInTheDocument();
    expect(anchor.querySelectorAll('button')).toHaveLength(2);
    expect(anchor.parentElement).toBe(container.firstChild);
  });

  it('renders the buttons unwrapped without anchorProps', () => {
    const { container } = render(<FormActions onCancel={vi.fn()} />);
    expect(container.querySelector('[data-tour-id]')).toBeNull();
    expect((container.firstChild as HTMLElement).children).toHaveLength(2);
  });

  describe('submit options', () => {
    const OPTIONS = [
      { id: 'close', label: 'Create' },
      { id: 'new', label: 'Create & New' },
    ];

    it('renders a split submit button labelled with the selected option', () => {
      render(
        <FormActions
          submitLabel="ignored"
          submitOptions={OPTIONS}
          selectedSubmitOptionId="new"
          onSubmitOptionChange={vi.fn()}
          submitOptionsLabel="Choose what happens after creating"
        />,
      );
      expect(screen.getByRole('button', { name: 'Create & New' })).toBeInTheDocument();
      expect(screen.queryByText('ignored')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Choose what happens after creating' }),
      ).toBeInTheDocument();
    });

    it('reports the chosen option', () => {
      const onSubmitOptionChange = vi.fn();
      render(
        <FormActions
          submitOptions={OPTIONS}
          selectedSubmitOptionId="close"
          onSubmitOptionChange={onSubmitOptionChange}
          submitOptionsLabel="Choose what happens after creating"
        />,
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Choose what happens after creating' }),
      );
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Create & New' }));
      expect(onSubmitOptionChange).toHaveBeenCalledWith('new');
    });

    it.each([
      ['a single option', { submitOptions: [OPTIONS[0]] }],
      ['no selection', { selectedSubmitOptionId: undefined }],
      ['no change handler', { onSubmitOptionChange: undefined }],
      ['no accessible name for the chevron', { submitOptionsLabel: undefined }],
      ['no options at all', { submitOptions: undefined }],
    ])('keeps the plain submit button with %s', (_case, overrides) => {
      render(
        <FormActions
          submitLabel="Create"
          submitOptions={OPTIONS}
          selectedSubmitOptionId="close"
          onSubmitOptionChange={vi.fn()}
          submitOptionsLabel="Choose what happens after creating"
          {...overrides}
        />,
      );
      // An incomplete set of option props must degrade to the button every
      // other form in the app uses, never to an unlabelled chevron.
      expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
      expect(screen.getAllByRole('button')).toHaveLength(1);
    });
  });

  it('draws secondary actions between Cancel and the submit', () => {
    render(
      <FormActions
        onCancel={vi.fn()}
        secondaryActions={<button type="button">Full Form</button>}
      />,
    );
    const labels = screen.getAllByRole('button').map((button) => button.textContent);
    expect(labels).toEqual(['Cancel', 'Full Form', 'Save']);
  });
});

describe('FormActions leading content', () => {
  it('renders it at the start of the row beside the buttons', () => {
    render(<FormActions onCancel={() => {}} leading={<span data-testid="lead">hint</span>} />);
    expect(screen.getByTestId('lead')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });
});
