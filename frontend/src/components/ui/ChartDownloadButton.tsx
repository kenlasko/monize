'use client';

import { RefObject, useState } from 'react';
import toast from 'react-hot-toast';
import { captureSvgAsImage } from '@/lib/pdf-export-charts';

interface ChartDownloadButtonProps {
  chartRef: RefObject<HTMLElement | null>;
  filename: string;
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return cleaned.toLowerCase() || 'chart';
}

export function ChartDownloadButton({ chartRef, filename }: ChartDownloadButtonProps) {
  const [isDownloading, setIsDownloading] = useState(false);

  async function handleDownload() {
    if (!chartRef.current || isDownloading) return;
    setIsDownloading(true);
    try {
      const captured = await captureSvgAsImage(chartRef.current);
      if (!captured) {
        toast.error('Unable to capture chart image');
        return;
      }
      const link = document.createElement('a');
      link.href = captured.dataUrl;
      link.download = `${sanitizeFilename(filename)}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch {
      toast.error('Failed to download chart');
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={isDownloading}
      className="p-1 rounded text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      title={`Download ${filename} as PNG`}
      aria-label={`Download ${filename} as PNG`}
    >
      <svg
        className="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
        />
      </svg>
    </button>
  );
}
