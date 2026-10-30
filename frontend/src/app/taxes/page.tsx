'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRightIcon, ReceiptPercentIcon } from '@heroicons/react/24/outline';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { CARD_CLASS } from '@/components/ui/Card';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { docsUrl } from '@/lib/docs-links';

/**
 * The tax tools, one card each (docs/specs/payroll-deductions.md section 1).
 * Declared as a list so the next tool is one more entry. `anchor` is the
 * card's guided-tour anchor, attached here and nowhere else.
 */
const TAX_TOOLS = [
  {
    key: 'payrollDeductions',
    href: '/taxes/payroll-deductions',
    Icon: ReceiptPercentIcon,
    anchor: tourAnchor(TOUR_ANCHORS.taxesPayrollDeductions),
  },
] as const;

export default function TaxesPage() {
  return (
    <ProtectedRoute>
      <TaxesContent />
    </ProtectedRoute>
  );
}

function TaxesContent() {
  const t = useTranslations('taxes.landing');
  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader title={t('title')} subtitle={t('subtitle')} helpUrl={docsUrl('taxes')} />
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {TAX_TOOLS.map(({ key, href, Icon, anchor }) => (
            <li key={key}>
              <Link
                href={href}
                {...anchor}
                className={`${CARD_CLASS} block p-6 hover:shadow-md transition-shadow motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-blue-500`}
              >
                <div className="flex items-start gap-4">
                  <Icon className="h-8 w-8 flex-shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      {t(`tools.${key}.title`)}
                    </h2>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{t(`tools.${key}.description`)}</p>
                  </div>
                  <ChevronRightIcon className="h-5 w-5 flex-shrink-0 text-gray-400" aria-hidden="true" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </PageLayout>
  );
}
