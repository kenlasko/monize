import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { MnyImportProgress } from './MnyImportProgress';
import type { MnyImportJob } from '@/lib/import-mny';
import { KMY_FORMAT } from '@/lib/binary-import-format';

function job(overrides: Partial<MnyImportJob> = {}): MnyImportJob {
  return {
    id: 'job-1',
    status: 'running',
    progress: null,
    result: null,
    errorKey: null,
    retryable: false,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('MnyImportProgress', () => {
  const defaultProps = {
    job: job(),
    isStarting: false,
    onRetry: vi.fn(),
    onStartOver: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());

  it('lists every phase in the order the import runs them', () => {
    render(<MnyImportProgress {...defaultProps} />);

    const phases = [
      'Preparing',
      'Accounts, categories and payees',
      'Transactions',
      'Investments',
      'Scheduled bills',
      'Prices and exchange rates',
      'Recalculating balances',
      'Verifying',
    ];
    const rendered = screen.getAllByRole('listitem').map((li) => li.textContent);
    for (const [index, phase] of phases.entries()) {
      expect(rendered[index]).toContain(phase);
    }
  });

  it('shows row progress and a percentage for the running phase', () => {
    render(
      <MnyImportProgress
        {...defaultProps}
        job={job({
          progress: { phase: 'transactions', processed: 500, total: 2000 },
        })}
      />,
    );

    expect(screen.getByText('500 of 2000')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
  });

  it('caps the bar at 100 rather than overflowing', () => {
    render(
      <MnyImportProgress
        {...defaultProps}
        job={job({
          progress: { phase: 'transactions', processed: 2500, total: 2000 },
        })}
      />,
    );

    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
  });

  it('omits the bar for a phase with no countable rows', () => {
    render(
      <MnyImportProgress
        {...defaultProps}
        job={job({
          progress: { phase: 'finalizing', processed: 0, total: 0 },
        })}
      />,
    );

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('says the import survives leaving the page, because it does', () => {
    render(<MnyImportProgress {...defaultProps} />);

    expect(
      screen.getByText(/you can leave this page and come back/),
    ).toBeInTheDocument();
  });

  it('shows the job as preparing before the first progress report', () => {
    render(<MnyImportProgress {...defaultProps} job={null} />);

    expect(screen.getByText(/Importing your Money file/)).toBeInTheDocument();
  });

  describe('a failed job', () => {
    it('shows the localized reason from the job error key', () => {
      render(
        <MnyImportProgress
          {...defaultProps}
          job={job({ status: 'failed', errorKey: 'mnyJobStalled' })}
        />,
      );

      expect(
        screen.getByText(/The import stopped responding/),
      ).toBeInTheDocument();
    });

    it('offers Retry when the backend says the staged file survives', () => {
      render(
        <MnyImportProgress
          {...defaultProps}
          job={job({
            status: 'failed',
            errorKey: 'mnyJobStalled',
            retryable: true,
          })}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(defaultProps.onRetry).toHaveBeenCalled();
    });

    it('hides Retry when retrying the same bytes cannot help', () => {
      render(
        <MnyImportProgress
          {...defaultProps}
          job={job({
            status: 'failed',
            errorKey: 'mnyPasswordIncorrect',
            retryable: false,
          })}
        />,
      );

      expect(
        screen.queryByRole('button', { name: 'Try again' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Start over' }),
      ).toBeInTheDocument();
    });

    it('falls back to a generic message when there is no error key', () => {
      render(
        <MnyImportProgress
          {...defaultProps}
          job={job({ status: 'failed', errorKey: null })}
        />,
      );

      expect(screen.getByText(/Nothing was saved/)).toBeInTheDocument();
    });

    it('does not say nothing was saved once the rows committed', () => {
      // A26-H08: a job that failed after its import transaction committed. The
      // generic copy invited a second import of the file, which doubled every
      // balance.
      render(
        <MnyImportProgress
          {...defaultProps}
          job={job({
            status: 'failed',
            errorKey: 'mnyImportFailed',
            dataCommitted: true,
          })}
        />,
      );

      expect(screen.queryByText(/Nothing was saved/)).not.toBeInTheDocument();
      expect(
        screen.getByText(/importing the same file again would duplicate them/),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Try again' }),
      ).not.toBeInTheDocument();
    });

    it('keeps the committed stall copy for a reaped committed job', () => {
      render(
        <MnyImportProgress
          {...defaultProps}
          job={job({
            status: 'failed',
            errorKey: 'mnyJobStalledAfterCommit',
            dataCommitted: true,
          })}
        />,
      );

      expect(screen.getByText(/stopped responding after it had already saved/)).toBeInTheDocument();
    });

    it('explains a commit refused because the file was already imported', () => {
      render(
        <MnyImportProgress
          {...defaultProps}
          job={job({ status: 'failed', errorKey: 'mnyAlreadyImported' })}
        />,
      );

      expect(screen.getByText(/already imported into your account/)).toBeInTheDocument();
    });

    it('starts over on request', () => {
      render(
        <MnyImportProgress
          {...defaultProps}
          job={job({ status: 'failed', errorKey: 'mnyImportFailed' })}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
      expect(defaultProps.onStartOver).toHaveBeenCalled();
    });
  });
});

describe('MnyImportProgress with a KMyMoney import', () => {
  const props = {
    job: job(),
    isStarting: false,
    onRetry: vi.fn(),
    onStartOver: vi.fn(),
    format: KMY_FORMAT,
  };

  it('names the KMyMoney file in the heading and keeps the same phases', () => {
    render(<MnyImportProgress {...props} />);

    expect(
      screen.getByRole('heading', { name: 'Importing your KMyMoney file' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Scheduled bills')).toBeInTheDocument();
  });

  it('reads a failed job from the Money catalog when the key is format-neutral', () => {
    render(
      <MnyImportProgress
        {...props}
        job={job({ status: 'failed', errorKey: 'mnyJobStalled', retryable: true })}
      />,
    );

    expect(screen.getByText(/stopped responding/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Learn more' }).getAttribute('href')).toContain(
      'troubleshooting-the-kmymoney-import',
    );
  });

  it('reads the staged-file key from the KMyMoney catalog', () => {
    render(
      <MnyImportProgress
        {...props}
        job={job({ status: 'failed', errorKey: 'mnyStagedFileMissing' })}
      />,
    );

    expect(
      screen.getByText('The uploaded KMyMoney file is no longer available. Please upload it again.'),
    ).toBeInTheDocument();
  });
});
