'use client';

import { DelegateSectionGuard } from '@/components/auth/DelegateSectionGuard';

export default function AiSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DelegateSectionGuard section="ai">{children}</DelegateSectionGuard>
  );
}
