'use client';

import { DelegateSectionGuard } from '@/components/auth/DelegateSectionGuard';

export default function InvestmentsSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DelegateSectionGuard section="investments">{children}</DelegateSectionGuard>
  );
}
