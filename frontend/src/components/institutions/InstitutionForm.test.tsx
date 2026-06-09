import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { InstitutionForm } from './InstitutionForm';

describe('InstitutionForm', () => {
  it('submits normalised data (country upper-cased)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<InstitutionForm onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'TD Bank' },
    });
    fireEvent.change(screen.getByLabelText('Website'), {
      target: { value: 'td.com' },
    });
    fireEvent.change(screen.getByLabelText('Country (optional)'), {
      target: { value: 'ca' },
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Create Institution'));
    });

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'TD Bank',
        website: 'td.com',
        country: 'CA',
      }),
    );
  });

  it('omits an empty country', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<InstitutionForm onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Acme' },
    });
    fireEvent.change(screen.getByLabelText('Website'), {
      target: { value: 'acme.com' },
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Create Institution'));
    });

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Acme',
        website: 'acme.com',
        country: undefined,
      }),
    );
  });

  it('shows a validation error for an empty name', async () => {
    const onSubmit = vi.fn();
    render(<InstitutionForm onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText('Website'), {
      target: { value: 'td.com' },
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Create Institution'));
    });

    await waitFor(() =>
      expect(screen.getByText('Name is required')).toBeInTheDocument(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects an invalid website', async () => {
    const onSubmit = vi.fn();
    render(<InstitutionForm onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'X' },
    });
    fireEvent.change(screen.getByLabelText('Website'), {
      target: { value: 'notaurl' },
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Create Institution'));
    });

    await waitFor(() =>
      expect(
        screen.getByText('Enter a valid website (e.g. td.com)'),
      ).toBeInTheDocument(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('prefills the name for inline creation', () => {
    render(
      <InstitutionForm
        initialName="Acme Bank"
        onSubmit={vi.fn()}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByLabelText('Name')).toHaveValue('Acme Bank');
  });

  it('edits an existing institution', () => {
    render(
      <InstitutionForm
        institution={
          {
            id: 'i-1',
            name: 'Existing',
            website: 'https://existing.com',
            country: 'US',
          } as never
        }
        onSubmit={vi.fn()}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByLabelText('Name')).toHaveValue('Existing');
    expect(screen.getByText('Save Changes')).toBeInTheDocument();
  });
});
