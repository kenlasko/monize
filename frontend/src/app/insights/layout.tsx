'use client';

import { DelegateSectionGuard } from '@/components/auth/DelegateSectionGuard';

export default function InsightsSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DelegateSectionGuard section="ai">{children}</DelegateSectionGuard>
  );
}
