'use client';

import { DelegateSectionGuard } from '@/components/auth/DelegateSectionGuard';

export default function BudgetsSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DelegateSectionGuard section="budgets">{children}</DelegateSectionGuard>
  );
}
