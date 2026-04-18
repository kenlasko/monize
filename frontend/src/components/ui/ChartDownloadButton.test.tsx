import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { RefObject } from 'react';
import { ChartDownloadButton } from './ChartDownloadButton';

const mockCaptureSvgAsImage = vi.fn();
vi.mock('@/lib/pdf-export-charts', () => ({
  captureSvgAsImage: (...args: any[]) => mockCaptureSvgAsImage(...args),
}));

const mockToastError = vi.fn();
vi.mock('react-hot-toast', () => ({
  default: {
    error: (...args: any[]) => mockToastError(...args),
    success: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

function makeRef(): RefObject<HTMLElement | null> {
  const el = document.createElement('div');
  return { current: el };
}

describe('ChartDownloadButton', () => {
  beforeEach(() => {
    mockCaptureSvgAsImage.mockReset();
    mockToastError.mockReset();
  });

  it('renders a download button with an accessible label containing the filename', () => {
    render(<ChartDownloadButton chartRef={makeRef()} filename="Balance History" />);
    expect(screen.getByRole('button', { name: /download balance history as png/i })).toBeInTheDocument();
  });

  it('triggers a download with a sanitized filename derived from the title', async () => {
    mockCaptureSvgAsImage.mockResolvedValue({ dataUrl: 'data:image/png;base64,XYZ', width: 100, height: 100 });
    const createElementSpy = vi.spyOn(document, 'createElement');

    render(<ChartDownloadButton chartRef={makeRef()} filename="Balance History" />);
    fireEvent.click(screen.getByRole('button'));

    // Wait for the download <a> element to be created.
    await waitFor(() => {
      const anchorCall = createElementSpy.mock.calls.find(([tag]) => tag === 'a');
      expect(anchorCall).toBeDefined();
    });

    // The most recently created anchor should have the expected download attribute.
    const anchors = createElementSpy.mock.results
      .map((r) => r.value as HTMLElement)
      .filter((el) => el instanceof HTMLAnchorElement) as HTMLAnchorElement[];
    const last = anchors[anchors.length - 1];
    expect(last.download).toBe('balance-history.png');
    expect(last.href).toContain('data:image/png');

    createElementSpy.mockRestore();
  });

  it('produces different sanitized filenames for each chart title', async () => {
    mockCaptureSvgAsImage.mockResolvedValue({ dataUrl: 'data:image/png;base64,XYZ', width: 100, height: 100 });

    const cases = [
      { title: 'Account Balances', expected: 'account-balances.png' },
      { title: 'Monthly Totals', expected: 'monthly-totals.png' },
      { title: 'Balance History', expected: 'balance-history.png' },
    ];

    for (const { title, expected } of cases) {
      const createElementSpy = vi.spyOn(document, 'createElement');
      const { unmount } = render(
        <ChartDownloadButton chartRef={makeRef()} filename={title} />,
      );
      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        const anchors = createElementSpy.mock.results
          .map((r) => r.value as HTMLElement)
          .filter((el) => el instanceof HTMLAnchorElement) as HTMLAnchorElement[];
        expect(anchors.some((a) => a.download === expected)).toBe(true);
      });

      createElementSpy.mockRestore();
      unmount();
    }
  });

  it('shows an error toast when the chart cannot be captured', async () => {
    mockCaptureSvgAsImage.mockResolvedValue(null);

    render(<ChartDownloadButton chartRef={makeRef()} filename="Balance History" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Unable to capture chart image');
    });
  });

  it('shows an error toast when capture throws', async () => {
    mockCaptureSvgAsImage.mockRejectedValue(new Error('boom'));

    render(<ChartDownloadButton chartRef={makeRef()} filename="Balance History" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Failed to download chart');
    });
  });

  it('does not call capture when the chart ref is not attached', async () => {
    render(<ChartDownloadButton chartRef={{ current: null }} filename="Balance History" />);
    fireEvent.click(screen.getByRole('button'));

    // Give microtasks a chance to run; there is nothing to await here so just
    // assert synchronously that the capture util was never invoked.
    await Promise.resolve();
    expect(mockCaptureSvgAsImage).not.toHaveBeenCalled();
  });

  it('disables the button while a download is in progress', async () => {
    let resolveCapture: (v: any) => void = () => {};
    mockCaptureSvgAsImage.mockImplementation(
      () => new Promise((r) => { resolveCapture = r; }),
    );

    render(<ChartDownloadButton chartRef={makeRef()} filename="Balance History" />);
    const button = screen.getByRole('button') as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => expect(button.disabled).toBe(true));

    resolveCapture({ dataUrl: 'data:image/png;base64,XYZ', width: 100, height: 100 });

    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('falls back to "chart" as the filename when the title has no alphanumerics', async () => {
    mockCaptureSvgAsImage.mockResolvedValue({ dataUrl: 'data:image/png;base64,XYZ', width: 100, height: 100 });
    const createElementSpy = vi.spyOn(document, 'createElement');

    render(<ChartDownloadButton chartRef={makeRef()} filename="!!!---" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      const anchors = createElementSpy.mock.results
        .map((r) => r.value as HTMLElement)
        .filter((el) => el instanceof HTMLAnchorElement) as HTMLAnchorElement[];
      expect(anchors.some((a) => a.download === 'chart.png')).toBe(true);
    });

    createElementSpy.mockRestore();
  });
});
