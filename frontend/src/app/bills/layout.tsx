'use client';

import { DelegateSectionGuard } from '@/components/auth/DelegateSectionGuard';

export default function BillsSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DelegateSectionGuard section="bills">{children}</DelegateSectionGuard>
  );
}
