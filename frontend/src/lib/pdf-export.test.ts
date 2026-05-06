import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock jspdf
const mockSave = vi.fn();
const mockText = vi.fn();
const mockAddImage = vi.fn();
const mockSetFontSize = vi.fn();
const mockSetFont = vi.fn();
const mockSetTextColor = vi.fn();
const mockSetDrawColor = vi.fn();
const mockSetLineWidth = vi.fn();
const mockLine = vi.fn();
const mockAddPage = vi.fn();
const mockSetPage = vi.fn();
const mockGetNumberOfPages = vi.fn().mockReturnValue(1);

vi.mock('jspdf', () => {
  class MockJsPDF {
    save = mockSave;
    text = mockText;
    addImage = mockAddImage;
    setFontSize = mockSetFontSize;
    setFont = mockSetFont;
    setTextColor = mockSetTextColor;
    setDrawColor = mockSetDrawColor;
    setLineWidth = mockSetLineWidth;
    line = mockLine;
    addPage = mockAddPage;
    setPage = mockSetPage;
    getNumberOfPages = mockGetNumberOfPages;
    splitTextToSize = vi.fn((text: string) => [text]);
    getTextWidth = vi.fn(() => 10);
    setFillColor = vi.fn();
    rect = vi.fn();
    internal = {
      pageSize: { getWidth: () => 297, getHeight: () => 210 },
    };
  }
  return { jsPDF: MockJsPDF };
});

// Mock chart capture
vi.mock('./pdf-export-charts', () => ({
  captureAllChartsAsImages: vi.fn().mockResolvedValue([]),
}));

// Mock table rendering
vi.mock('./pdf-export-tables', () => ({
  addTableToPdf: vi.fn().mockReturnValue(100),
}));

// Mock summary cards rendering
const mockAddSummaryCards = vi.fn().mockReturnValue(50);
vi.mock('./pdf-export-cards', () => ({
  addSummaryCardsToPdf: (...args: unknown[]) => mockAddSummaryCards(...args),
}));

describe('exportToPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a PDF with title and saves it', async () => {
    const { exportToPdf } = await import('./pdf-export');

    await exportToPdf({
      title: 'Test Report',
      filename: 'test-report',
    });

    expect(mockText).toHaveBeenCalledWith('Test Report', expect.any(Number), expect.any(Number));
    expect(mockSave).toHaveBeenCalledWith('test-report.pdf');
  });

  it('appends .pdf extension if missing', async () => {
    const { exportToPdf } = await import('./pdf-export');

    await exportToPdf({
      title: 'Report',
      filename: 'my-report',
    });

    expect(mockSave).toHaveBeenCalledWith('my-report.pdf');
  });

  it('does not double .pdf extension', async () => {
    const { exportToPdf } = await import('./pdf-export');

    await exportToPdf({
      title: 'Report',
      filename: 'my-report.pdf',
    });

    expect(mockSave).toHaveBeenCalledWith('my-report.pdf');
  });

  it('includes subtitle when provided', async () => {
    const { exportToPdf } = await import('./pdf-export');

    await exportToPdf({
      title: 'Report',
      subtitle: 'Jan 2024 - Dec 2024',
      filename: 'report',
    });

    expect(mockText).toHaveBeenCalledWith(
      'Jan 2024 - Dec 2024',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('renders table data when provided', async () => {
    const { exportToPdf } = await import('./pdf-export');
    const { addTableToPdf } = await import('./pdf-export-tables');

    await exportToPdf({
      title: 'Report',
      tableData: {
        headers: ['Name', 'Value'],
        rows: [['A', 100]],
      },
      filename: 'report',
    });

    expect(addTableToPdf).toHaveBeenCalled();
  });

  it('adds page numbers to footer', async () => {
    const { exportToPdf } = await import('./pdf-export');

    await exportToPdf({
      title: 'Report',
      filename: 'report',
    });

    // Should call setPage for footer
    expect(mockSetPage).toHaveBeenCalledWith(1);
    // Should have "Monize" and page number in footer
    expect(mockText).toHaveBeenCalledWith('Monize', expect.any(Number), expect.any(Number));
    expect(mockText).toHaveBeenCalledWith(
      'Page 1 of 1',
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ align: 'right' }),
    );
  });

  it('adds multiple chart images when captureAllChartsAsImages returns multiple', async () => {
    const { captureAllChartsAsImages } = await import('./pdf-export-charts');
    const mockCapture = vi.mocked(captureAllChartsAsImages);
    mockCapture.mockResolvedValueOnce([
      { dataUrl: 'data:image/png;base64,chart1', width: 800, height: 400 },
      { dataUrl: 'data:image/png;base64,chart2', width: 800, height: 400 },
      { dataUrl: 'data:image/png;base64,chart3', width: 800, height: 400 },
    ]);

    const { exportToPdf } = await import('./pdf-export');
    const container = document.createElement('div');

    await exportToPdf({
      title: 'Multi Chart Report',
      chartContainer: container,
      filename: 'multi-chart',
    });

    expect(mockAddImage).toHaveBeenCalledTimes(3);
    expect(mockAddImage).toHaveBeenCalledWith(
      'data:image/png;base64,chart1', 'PNG',
      expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number),
    );
    expect(mockAddImage).toHaveBeenCalledWith(
      'data:image/png;base64,chart2', 'PNG',
      expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number),
    );
    expect(mockAddImage).toHaveBeenCalledWith(
      'data:image/png;base64,chart3', 'PNG',
      expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number),
    );
  });

  it('adds page breaks when charts exceed page height', async () => {
    const { captureAllChartsAsImages } = await import('./pdf-export-charts');
    const mockCapture = vi.mocked(captureAllChartsAsImages);
    // pageHeight is 210mm (landscape A4). With subtitle, currentY starts at 32.
    // maxHeight for multi-chart is 80mm. Each chart takes 80 + 8 = 88mm.
    // After chart 1: currentY = 32 + 80 + 8 = 120
    // Chart 2 needs 80mm, 120 + 80 = 200 > 210 - 20 = 190, so page break
    mockCapture.mockResolvedValueOnce([
      { dataUrl: 'data:image/png;base64,a', width: 400, height: 400 },
      { dataUrl: 'data:image/png;base64,b', width: 400, height: 400 },
    ]);

    const { exportToPdf } = await import('./pdf-export');
    const container = document.createElement('div');

    await exportToPdf({
      title: 'Tall Charts',
      subtitle: 'Testing page breaks',
      chartContainer: container,
      filename: 'tall-charts',
    });

    expect(mockAddPage).toHaveBeenCalled();
    expect(mockAddImage).toHaveBeenCalledTimes(2);
  });

  it('renders summary cards when provided', async () => {
    const { exportToPdf } = await import('./pdf-export');

    const summaryCards = [
      { label: 'Net Worth', value: '$100,000', color: '#16a34a' },
      { label: 'Change', value: '+$5,000', color: '#16a34a' },
    ];

    await exportToPdf({
      title: 'Report with Cards',
      summaryCards,
      filename: 'report-cards',
    });

    expect(mockAddSummaryCards).toHaveBeenCalledWith(
      expect.anything(),
      summaryCards,
      expect.objectContaining({
        startY: expect.any(Number),
        pageWidth: expect.any(Number),
        margin: expect.any(Number),
      }),
    );
  });

  it('does not render summary cards when not provided', async () => {
    mockAddSummaryCards.mockClear();
    const { exportToPdf } = await import('./pdf-export');

    await exportToPdf({
      title: 'Report without Cards',
      filename: 'report-no-cards',
    });

    expect(mockAddSummaryCards).not.toHaveBeenCalled();
  });

  it('renders description paragraph when provided', async () => {
    const { exportToPdf } = await import('./pdf-export');

    await exportToPdf({
      title: 'Report',
      description: 'Long description text that should be split into lines for the PDF.',
      filename: 'desc-report',
    });

    // splitTextToSize is invoked indirectly; ensure text rendered with the description
    expect(mockText).toHaveBeenCalled();
  });

  it('renders chart legend when provided', async () => {
    const { exportToPdf } = await import('./pdf-export');

    await exportToPdf({
      title: 'Report',
      chartLegend: [
        { color: '#ff0000', label: 'Red' },
        { color: '#00ff00', label: 'Green' },
      ],
      filename: 'legend-report',
    });

    // Legend renders rect with fill colours and text labels
    expect(mockText).toHaveBeenCalledWith('Red', expect.any(Number), expect.any(Number));
    expect(mockText).toHaveBeenCalledWith('Green', expect.any(Number), expect.any(Number));
  });

  it('renders additional tables with section titles', async () => {
    const { addTableToPdf } = await import('./pdf-export-tables');
    const { exportToPdf } = await import('./pdf-export');

    await exportToPdf({
      title: 'Report',
      additionalTables: [
        {
          title: 'Section A',
          headers: ['Col1'],
          rows: [['v1']],
          totalRow: ['Total'],
        },
      ],
      filename: 'add-tables',
    });

    expect(addTableToPdf).toHaveBeenCalled();
    expect(mockText).toHaveBeenCalledWith('Section A', expect.any(Number), expect.any(Number));
  });

  it('skips additional tables that have empty headers or rows', async () => {
    const { addTableToPdf } = await import('./pdf-export-tables');
    vi.mocked(addTableToPdf).mockClear();

    const { exportToPdf } = await import('./pdf-export');

    await exportToPdf({
      title: 'Report',
      additionalTables: [
        { headers: [], rows: [['x']] },
        { headers: ['A'], rows: [] },
      ],
      filename: 'skip-empty',
    });

    expect(addTableToPdf).not.toHaveBeenCalled();
  });

  it('renders multi-column charts when chartColumns > 1', async () => {
    const { captureAllChartsAsImages } = await import('./pdf-export-charts');
    vi.mocked(captureAllChartsAsImages).mockResolvedValueOnce([
      { dataUrl: 'data:image/png;base64,a', width: 400, height: 300 },
      { dataUrl: 'data:image/png;base64,b', width: 400, height: 300 },
    ]);

    const { exportToPdf } = await import('./pdf-export');
    const container = document.createElement('div');

    await exportToPdf({
      title: 'Two Charts',
      chartContainer: container,
      chartColumns: 2,
      filename: 'two-cols',
    });

    expect(mockAddImage).toHaveBeenCalledTimes(2);
  });

  it('continues table-only PDF when chart capture throws', async () => {
    const { captureAllChartsAsImages } = await import('./pdf-export-charts');
    vi.mocked(captureAllChartsAsImages).mockRejectedValueOnce(new Error('capture failed'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { exportToPdf } = await import('./pdf-export');
    const container = document.createElement('div');

    await exportToPdf({
      title: 'Failing chart',
      chartContainer: container,
      tableData: { headers: ['A'], rows: [['1']] },
      filename: 'fail-chart',
    });

    expect(warnSpy).toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('wraps legend onto a new line when items overflow available width', async () => {
    const { exportToPdf } = await import('./pdf-export');

    // Many items will overflow availableWidth (pageWidth - margin * 2 = 269)
    // Each item width is roughly SWATCH_SIZE(3) + 1.5 + textWidth(10) + ITEM_GAP(3) = 17.5
    // So 30 items >> 269 → wrap will occur
    const legend = Array.from({ length: 30 }, (_, i) => ({
      color: '#abcdef',
      label: `Long Label ${i}`,
    }));

    await exportToPdf({
      title: 'Wrap Legend',
      chartLegend: legend,
      filename: 'wrap-legend',
    });

    expect(mockText).toHaveBeenCalledWith('Long Label 0', expect.any(Number), expect.any(Number));
  });

  it('adds a page break before an additional table when not enough vertical space remains', async () => {
    const { addTableToPdf } = await import('./pdf-export-tables');
    // First call (main table) returns a Y close to pageHeight; the second call
    // (additional table) should occur after the page-break branch fires.
    vi.mocked(addTableToPdf).mockReturnValueOnce(180);

    const { exportToPdf } = await import('./pdf-export');

    await exportToPdf({
      title: 'Need Page Break',
      tableData: { headers: ['A'], rows: [['1']] },
      additionalTables: [{ title: 'Section B', headers: ['X'], rows: [['v']] }],
      filename: 'pagebreak',
    });

    expect(mockAddPage).toHaveBeenCalled();
  });

  it('drops the table on a new page when chart consumed too much height', async () => {
    const { captureAllChartsAsImages } = await import('./pdf-export-charts');
    vi.mocked(captureAllChartsAsImages).mockResolvedValueOnce([
      { dataUrl: 'data:image/png;base64,a', width: 100, height: 1000 },
    ]);

    const { exportToPdf } = await import('./pdf-export');
    const container = document.createElement('div');

    await exportToPdf({
      title: 'Tall Chart Then Table',
      chartContainer: container,
      tableData: { headers: ['A'], rows: [['1']] },
      filename: 'chart-then-table',
    });

    expect(mockAddPage).toHaveBeenCalled();
  });
});
