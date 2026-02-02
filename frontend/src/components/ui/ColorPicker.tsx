'use client';

import { useState } from 'react';

interface ColorPickerProps {
  value: string | null;
  onChange: (color: string) => void;
  label?: string;
}

// Color palette matching existing report cards
const COLORS = [
  '#3b82f6', // blue-500
  '#6366f1', // indigo-500
  '#8b5cf6', // purple-500
  '#a855f7', // violet-500
  '#ec4899', // pink-500
  '#ef4444', // red-500
  '#f97316', // orange-500
  '#eab308', // yellow-500
  '#22c55e', // green-500
  '#14b8a6', // teal-500
  '#06b6d4', // cyan-500
  '#0ea5e9', // sky-500
  '#64748b', // slate-500
  '#78716c', // stone-500
  '#71717a', // zinc-500
  '#737373', // neutral-500
];

export function ColorPicker({ value, onChange, label }: ColorPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [customColor, setCustomColor] = useState(value || '#3b82f6');

  const selectedColor = value || '#3b82f6';

  return (
    <div className="relative">
      {label && (
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {label}
        </label>
      )}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <div className="flex items-center gap-2">
          <div
            className="w-6 h-6 rounded-md border border-gray-300 dark:border-gray-500"
            style={{ backgroundColor: selectedColor }}
          />
          <span className="text-sm text-gray-600 dark:text-gray-400">{selectedColor}</span>
        </div>
        <svg
          className={`w-5 h-5 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute z-20 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg p-3">
            <div className="grid grid-cols-8 gap-2 mb-3">
              {COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => {
                    onChange(color);
                    setIsOpen(false);
                  }}
                  className={`w-7 h-7 rounded-md border-2 ${
                    value === color
                      ? 'border-gray-900 dark:border-white'
                      : 'border-transparent hover:border-gray-400'
                  }`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2 pt-2 border-t border-gray-200 dark:border-gray-700">
              <label className="text-xs text-gray-500 dark:text-gray-400">Custom:</label>
              <input
                type="color"
                value={customColor}
                onChange={(e) => setCustomColor(e.target.value)}
                className="w-8 h-8 cursor-pointer rounded border-0"
              />
              <input
                type="text"
                value={customColor}
                onChange={(e) => {
                  if (/^#[0-9A-Fa-f]{0,6}$/.test(e.target.value)) {
                    setCustomColor(e.target.value);
                  }
                }}
                className="flex-1 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                placeholder="#3b82f6"
              />
              <button
                type="button"
                onClick={() => {
                  if (/^#[0-9A-Fa-f]{6}$/.test(customColor)) {
                    onChange(customColor);
                    setIsOpen(false);
                  }
                }}
                className="px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600"
              >
                Apply
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
