import { Locator } from '@playwright/test';

export type IconSelectChoice =
  | { value: string }
  | { label: string | RegExp }
  | { index: number };

/**
 * Pick an option of an `IconSelect` -- every account dropdown in the app
 * (`AccountSelect`) and the rules editor's account fields -- the way a person
 * does: open the field, then click the row. These are not native selects, so
 * `selectOption` does not reach them. `field` is the combobox, found by its
 * label as before (`getByLabel('Account')`). A `value` is the row's id (the
 * account id), a `label` its text, an `index` its position counting the
 * placeholder row, as `selectOption({ index })` did.
 */
export async function chooseIconSelectOption(
  field: Locator,
  choice: IconSelectChoice,
): Promise<void> {
  await field.click();
  const listbox = field.page().getByRole('listbox');
  const option =
    'value' in choice
      ? listbox.locator(`[role="option"][data-value="${choice.value}"]`)
      : 'label' in choice
        ? listbox.getByRole('option', { name: choice.label, exact: typeof choice.label === 'string' })
        : listbox.getByRole('option').nth(choice.index);
  await option.click();
}
