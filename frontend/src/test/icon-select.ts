import { fireEvent, screen, within } from '@/test/render';

type Scope = Pick<typeof screen, 'getByLabelText' | 'queryByLabelText'>;

/**
 * The form `<select>` behind an `IconSelect` / `AccountSelect` (or a plain
 * `Select`) whose visible control is `trigger`. `IconSelect` keeps the form's
 * value in a hidden native select beside its combobox button; a test that reads
 * the value, lists the options or changes the value as a form would reads it
 * through this. A test of how a person picks an option uses the combobox.
 */
export function nativeSelectOf(trigger: HTMLElement): HTMLSelectElement {
  if (trigger instanceof HTMLSelectElement) return trigger;
  const select = trigger.parentElement?.querySelector<HTMLSelectElement>(
    'select[data-icon-select-native]',
  );
  if (!select) throw new Error('No IconSelect native select next to this control');
  return select;
}

/** `nativeSelectOf` the control labelled `label`. */
export function getSelectByLabel(
  label: string | RegExp,
  scope: Scope = screen,
): HTMLSelectElement {
  return nativeSelectOf(scope.getByLabelText(label));
}

/** `getSelectByLabel`, or null when no control carries that label. */
export function querySelectByLabel(
  label: string | RegExp,
  scope: Scope = screen,
): HTMLSelectElement | null {
  const trigger = scope.queryByLabelText(label);
  return trigger ? nativeSelectOf(trigger) : null;
}

/** The labels a select offers, in order, as its options carry them. */
export function selectOptionLabels(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((option) => option.label);
}

/** The values a select offers, in order. */
export function selectOptionValues(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((option) => option.value);
}

/** Change the select labelled `label` to `value`, as a pick in its list does. */
export function changeSelectByLabel(
  label: string | RegExp,
  value: string,
  scope: Scope = screen,
): void {
  fireEvent.change(getSelectByLabel(label, scope), { target: { value } });
}

/**
 * Open the `IconSelect` labelled `label` and click the row named `option`, the
 * way a person picks one.
 */
export function pickIconSelectOption(
  label: string | RegExp,
  option: string | RegExp,
  scope: Scope = screen,
): void {
  fireEvent.click(scope.getByLabelText(label));
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: option }));
}
