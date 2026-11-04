import { act, fireEvent, screen } from '@/test/render';

/**
 * Pick an option of a `Combobox` the way a person does: click the field by its
 * accessible name, wait for the option to be listed (the options may still be
 * loading), and click it. A string matches the start of the option's label, so
 * `'AAPL - '` picks "AAPL - Apple Inc. (USD)".
 */
export async function chooseComboboxOption(name: string, option: string | RegExp): Promise<void> {
  const input = screen.getByLabelText(name);
  await act(async () => {
    fireEvent.click(input);
  });
  const matcher =
    typeof option === 'string'
      ? new RegExp(`^${option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      : option;
  const row = await screen.findByText(matcher);
  await act(async () => {
    fireEvent.click(row);
  });
}
