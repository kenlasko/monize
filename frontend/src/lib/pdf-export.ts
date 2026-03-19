/**
 * PDF export utility for report data.
 * Generates professional financial report PDFs with charts and/or tables.
 */

import type { jsPDF } from 'jspdf';
import { captureSvgAsImage } from './pdf-export-charts';
import { addTableToPdf } from './pdf-export-tables';

type CellValue = string | number | null | undefined;

export interface PdfExportOptions {
  title: string;
  subtitle?: string;
  chartContainer?: HTMLElement | null;
  tableData?: {
    headers: string[];
    rows: CellValue[][];
    totalRow?: (string | number)[];
  };
  filename: string;
}

/**
 * Generates and downloads a PDF report.
 * Includes a chart image (if container provided) and/or a data table.
 */
export async function exportToPdf(options: PdfExportOptions): Promise<void> {
  const { title, subtitle, chartContainer, tableData, filename } = options;

  const hasChart = !!chartContainer;
  const hasTable = tableData && tableData.headers.length > 0;

  // Dynamically import jspdf to avoid Turbopack SSR bundling issues with fflate
  const { jsPDF } = await import('jspdf');

  // Use landscape for chart-only or chart+table, portrait for table-only
  const orientation = hasChart ? 'landscape' : 'portrait';
  const doc = new jsPDF({ orientation, unit: 'mm', format: 'a4' });

  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;

  // Header
  addHeader(doc, title, subtitle, pageWidth, margin);

  let currentY = subtitle ? 32 : 26;

  // Chart
  if (hasChart && chartContainer) {
    try {
      const chart = await captureSvgAsImage(chartContainer);
      if (chart) {
        const maxWidth = pageWidth - margin * 2;
        const maxHeight = orientation === 'landscape' ? 120 : 160;
        const aspectRatio = chart.width / chart.height;
        let imgWidth = maxWidth;
        let imgHeight = imgWidth / aspectRatio;
        if (imgHeight > maxHeight) {
          imgHeight = maxHeight;
          imgWidth = imgHeight * aspectRatio;
        }
        const xOffset = (pageWidth - imgWidth) / 2;
        doc.addImage(chart.dataUrl, 'PNG', xOffset, currentY, imgWidth, imgHeight);
        currentY += imgHeight + 10;
      }
    } catch {
      // Chart capture failed; continue with table only
    }
  }

  // Table
  if (hasTable) {
    const pageHeight = doc.internal.pageSize.getHeight();
    // If chart took too much space, add a new page for the table
    if (hasChart && currentY > pageHeight - 60) {
      doc.addPage();
      addHeader(doc, title, subtitle, pageWidth, margin);
      currentY = subtitle ? 32 : 26;
    }
    addTableToPdf(doc, tableData.headers, tableData.rows, {
      startY: currentY,
      showTotalRow: !!tableData.totalRow,
      totalRow: tableData.totalRow,
    });
  }

  // Footer on all pages
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    addFooter(doc, i, totalPages, pageWidth);
  }

  const pdfFilename = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
  doc.save(pdfFilename);
}

function addHeader(
  doc: jsPDF,
  title: string,
  subtitle: string | undefined,
  pageWidth: number,
  margin: number,
): void {
  // Title
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 58, 95);
  doc.text(title, margin, 14);

  // Subtitle / date info
  if (subtitle) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(107, 114, 128);
    doc.text(subtitle, margin, 22);
  }

  // Generation timestamp on the right
  const now = new Date();
  const timestamp = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(156, 163, 175);
  doc.text(`Generated: ${timestamp}`, pageWidth - margin, 14, { align: 'right' });

  // Separator line
  const lineY = subtitle ? 27 : 19;
  doc.setDrawColor(229, 231, 235);
  doc.setLineWidth(0.5);
  doc.line(margin, lineY, pageWidth - margin, lineY);
}

function addFooter(
  doc: jsPDF,
  pageNumber: number,
  totalPages: number,
  pageWidth: number,
): void {
  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(156, 163, 175);
  doc.text('Monize', 14, pageHeight - 8);
  doc.text(
    `Page ${pageNumber} of ${totalPages}`,
    pageWidth - 14,
    pageHeight - 8,
    { align: 'right' },
  );
}
