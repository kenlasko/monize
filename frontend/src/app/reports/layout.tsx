'use client';

import { DelegateSectionGuard } from '@/components/auth/DelegateSectionGuard';

export default function ReportsSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DelegateSectionGuard section="reports">{children}</DelegateSectionGuard>
  );
}
