'use client';

import { useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/20/solid';

export interface SettingsSection {
  readonly id: string;
  readonly label: string;
  /** If set, renders as a navigation link instead of a scroll-to button */
  readonly href?: string;
}

interface SettingsNavProps {
  readonly sections: readonly SettingsSection[];
  readonly activeSection: string;
  readonly onSectionClick: (id: string) => void;
  readonly variant?: 'vertical' | 'horizontal';
}

export function SettingsNav({
  sections,
  activeSection,
  onSectionClick,
  variant = 'vertical',
}: SettingsNavProps) {
  const activeRef = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll active tab into view for horizontal variant
  useEffect(() => {
    if (variant === 'horizontal' && activeRef.current?.scrollIntoView && scrollContainerRef.current) {
      activeRef.current.scrollIntoView({
        inline: 'center',
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [activeSection, variant]);

  const setActiveRef = useCallback(
    (id: string) => (el: HTMLButtonElement | HTMLAnchorElement | null) => {
      if (id === activeSection) {
        activeRef.current = el;
      }
    },
    [activeSection],
  );

  if (variant === 'horizontal') {
    return (
      <div
        ref={scrollContainerRef}
        className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide"
        role="tablist"
        aria-label="Settings sections"
      >
        {sections.map((section) => {
          const isActive = section.id === activeSection;

          if (section.href) {
            return (
              <Link
                key={section.id}
                href={section.href}
                ref={setActiveRef(section.id) as React.Ref<HTMLAnchorElement>}
                className={`
                  flex items-center gap-1 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-colors shrink-0
                  ${isActive
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-200'
                  }
                `}
                role="tab"
                aria-selected={isActive}
              >
                {section.label}
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
              </Link>
            );
          }

          return (
            <button
              key={section.id}
              ref={setActiveRef(section.id) as React.Ref<HTMLButtonElement>}
              onClick={() => onSectionClick(section.id)}
              className={`
                whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-colors shrink-0
                ${isActive
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-200'
                }
              `}
              role="tab"
              aria-selected={isActive}
            >
              {section.label}
            </button>
          );
        })}
      </div>
    );
  }

  // Vertical sidebar variant
  return (
    <nav
      className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-2"
      aria-label="Settings sections"
    >
      <ul className="space-y-0.5">
        {sections.map((section) => {
          const isActive = section.id === activeSection;

          if (section.href) {
            return (
              <li key={section.id}>
                <Link
                  href={section.href}
                  ref={setActiveRef(section.id) as React.Ref<HTMLAnchorElement>}
                  className={`
                    flex items-center justify-between w-full rounded-md px-3 py-2 text-sm font-medium transition-colors
                    ${isActive
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }
                  `}
                >
                  {section.label}
                  <ArrowTopRightOnSquareIcon className="h-4 w-4 opacity-50" />
                </Link>
              </li>
            );
          }

          return (
            <li key={section.id}>
              <button
                ref={setActiveRef(section.id) as React.Ref<HTMLButtonElement>}
                onClick={() => onSectionClick(section.id)}
                className={`
                  w-full text-left rounded-md px-3 py-2 text-sm font-medium transition-colors
                  ${isActive
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }
                `}
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
