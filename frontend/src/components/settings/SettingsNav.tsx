'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { ArrowTopRightOnSquareIcon, ChevronDownIcon } from '@heroicons/react/20/solid';
import { useTranslations } from 'next-intl';
import { useClickOutside } from '@/hooks/useClickOutside';

export interface SettingsSection {
  readonly id: string;
  readonly label: string;
  /** If set, renders as a navigation link instead of a scroll-to button */
  readonly href?: string;
  /** Visual treatment for the nav item (e.g. 'danger' renders in red) */
  readonly variant?: 'default' | 'danger';
}

interface SettingsNavProps {
  readonly sections: readonly SettingsSection[];
  readonly activeSection: string;
  readonly onSectionClick: (id: string) => void;
  readonly variant?: 'vertical' | 'dropdown';
}

/**
 * Colour classes for a scroll-to (button) section. The four-way matrix covers
 * active/inactive against default/danger so the desktop sidebar and the mobile
 * dropdown stay visually identical.
 */
function navItemColors(isActive: boolean, isDanger: boolean): string {
  if (isActive) {
    return isDanger
      ? 'bg-red-50 text-red-700 dark:bg-red-900/40 dark:text-red-300'
      : 'bg-blue-50 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200';
  }
  return isDanger
    ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30'
    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700';
}

/** Colour classes for a link section (links are never the danger variant). */
function navLinkColors(isActive: boolean): string {
  return isActive
    ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200'
    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700';
}

export function SettingsNav({
  sections,
  activeSection,
  onSectionClick,
  variant = 'vertical',
}: SettingsNavProps) {
  const t = useTranslations('settings.nav');
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useClickOutside(dropdownRef, () => setOpen(false), {
    enabled: open,
    onEscape: () => setOpen(false),
  });

  if (variant === 'dropdown') {
    // Compact control showing the active section; tapping it reveals every
    // section at once instead of a cramped horizontally-scrolling tab strip.
    const current =
      sections.find((s) => s.id === activeSection) ?? sections[0];

    return (
      <div ref={dropdownRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-haspopup="true"
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-900 dark:text-gray-100 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
        >
          <span className="truncate">{current?.label}</span>
          <ChevronDownIcon
            className={`h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500 transition-transform ${
              open ? 'rotate-180' : ''
            }`}
          />
        </button>

        {open && (
          <nav
            aria-label={t('sectionsAriaLabel')}
            className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[70vh] overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg dark:shadow-gray-700/50"
          >
            <ul className="py-1">
              {sections.map((section) => {
                const isActive = section.id === activeSection;

                if (section.href) {
                  return (
                    <li key={section.id}>
                      <Link
                        href={section.href}
                        onClick={() => setOpen(false)}
                        className={`flex items-center justify-between gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${navLinkColors(isActive)}`}
                      >
                        <span className="inline-flex items-center">
                          {section.label}
                        </span>
                        <ArrowTopRightOnSquareIcon className="h-4 w-4 opacity-50" />
                      </Link>
                    </li>
                  );
                }

                return (
                  <li key={section.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onSectionClick(section.id);
                        setOpen(false);
                      }}
                      className={`block w-full text-left px-4 py-2.5 text-sm font-medium transition-colors ${navItemColors(isActive, section.variant === 'danger')}`}
                    >
                      {section.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </div>
    );
  }

  // Vertical sidebar variant
  return (
    <nav
      className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-2"
      aria-label={t('sectionsAriaLabel')}
    >
      <ul className="space-y-0.5">
        {sections.map((section) => {
          const isActive = section.id === activeSection;

          if (section.href) {
            return (
              <li key={section.id}>
                <Link
                  href={section.href}
                  className={`flex items-center justify-between w-full rounded-md px-3 py-2 text-sm font-medium transition-colors ${navLinkColors(isActive)}`}
                >
                  <span className="inline-flex items-center">
                    {section.label}
                  </span>
                  <ArrowTopRightOnSquareIcon className="h-4 w-4 opacity-50" />
                </Link>
              </li>
            );
          }

          return (
            <li key={section.id}>
              <button
                onClick={() => onSectionClick(section.id)}
                className={`w-full text-left rounded-md px-3 py-2 text-sm font-medium transition-colors ${navItemColors(isActive, section.variant === 'danger')}`}
              >
                {section.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
