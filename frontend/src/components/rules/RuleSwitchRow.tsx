'use client';

import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';

/** A switch with its name and a tooltip that explains it. */
export function RuleSwitchRow({
  checked,
  onChange,
  label,
  help,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  help: string;
}) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <ToggleSwitch checked={checked} onChange={onChange} label={label} />
      <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
      <InfoTooltip text={help} placement="top" usePortal />
    </div>
  );
}
