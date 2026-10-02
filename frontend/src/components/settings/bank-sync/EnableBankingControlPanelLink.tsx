import type { ReactNode } from 'react';
import { ENABLE_BANKING_CONTROL_PANEL_URL } from '@/lib/bank-sync-links';
import { BankSyncExternalLink } from './BankSyncExternalLink';

/**
 * The link to the Enable Banking control panel, shared by the credentials card
 * and its modal. The attributes come from `BankSyncExternalLink`.
 */
export function EnableBankingControlPanelLink({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <BankSyncExternalLink href={ENABLE_BANKING_CONTROL_PANEL_URL}>
      {children}
    </BankSyncExternalLink>
  );
}
