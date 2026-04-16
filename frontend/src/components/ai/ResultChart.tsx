'use client';

import { useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';
import { captureSvgAsImage } from '@/lib/pdf-export-charts';

const COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

interface ChartData {
  label: string;
  value: number;
}

interface ResultChartProps {
  type: 'bar' | 'pie' | 'line' | 'area';
  title: string;
  data: ChartData[];
}

function formatCurrency(value: number | undefined): string {
  if (value === undefined) return '';
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; payload?: { label?: string } }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const heading = label ?? payload[0]?.payload?.label ?? payload[0]?.name;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
      {heading && (
        <p className="font-medium text-gray-900 dark:text-gray-100">{heading}</p>
      )}
      {payload.map((entry, index) => (
        <p
          key={`tooltip-${index}`}
          className="text-sm text-blue-600 dark:text-blue-400"
        >
          {formatCurrency(entry.value)}
        </p>
      ))}
    </div>
  );
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return cleaned.toLowerCase() || 'chart';
}

export function ResultChart({ type, title, data }: ResultChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  if (!data || data.length === 0) return null;

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
      link.download = `${sanitizeFilename(title)}.png`;
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
    <div className="mt-3 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {title}
        </h4>
        <button
          type="button"
          onClick={handleDownload}
          disabled={isDownloading}
          className="p-1 rounded text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Download chart as PNG"
          aria-label="Download chart as PNG"
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
      </div>
      <div ref={chartRef} className="h-64">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          {type === 'pie' ? (
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="label"
                cx="50%"
                cy="50%"
                outerRadius={80}
                label={({ name, percent }: { name?: string; percent?: number }) =>
                  `${name ?? ''} (${((percent ?? 0) * 100).toFixed(0)}%)`
                }
              >
                {data.map((_, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={COLORS[index % COLORS.length]}
                  />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip />} />
            </PieChart>
          ) : type === 'area' || type === 'line' ? (
            <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip content={<ChartTooltip />} />
              <Area
                type="monotone"
                dataKey="value"
                stroke="#3b82f6"
                fill="#bfdbfe"
              />
            </AreaChart>
          ) : (
            <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {data.map((_, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={COLORS[index % COLORS.length]}
                  />
                ))}
              </Bar>
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
