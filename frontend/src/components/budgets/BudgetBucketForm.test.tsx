import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import {
  BudgetBucketForm,
  buildBudgetBucketFormSchema,
  normalizeBudgetBucketName,
  toBudgetBucketDraft,
} from './BudgetBucketForm';

// The schema only needs the key back to say which message it chose.
const keyOnly = (key: string) => key;

function issues(input: Record<string, unknown>, otherNames: string[] = []) {
  const result = buildBudgetBucketFormSchema(keyOnly, otherNames).safeParse({
    name: 'Savings',
    targetType: 'PERCENT',
    targetValue: 20,
    carryOver: false,
    ...input,
  });
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

describe('buildBudgetBucketFormSchema', () => {
  it('accepts a valid percent bucket and a valid amount bucket', () => {
    expect(issues({})).toEqual([]);
    expect(issues({ targetType: 'AMOUNT', targetValue: 250.5 })).toEqual([]);
  });

  it('requires a name of 1 to 50 characters after trimming', () => {
    expect(issues({ name: '   ' })).toEqual(['bucketEditor.validation.nameRequired']);
    expect(issues({ name: 'x'.repeat(51) })).toEqual(['bucketEditor.validation.nameMax']);
    expect(issues({ name: `  ${'x'.repeat(50)}  ` })).toEqual([]);
  });

  it('refuses a name another bucket has, ignoring case and surrounding space', () => {
    expect(issues({ name: ' SAVINGS ' }, ['Savings'])).toEqual(['bucketEditor.validation.nameDuplicate']);
    expect(issues({ name: 'Savings 2' }, ['Savings'])).toEqual([]);
  });

  it('requires a target', () => {
    expect(issues({ targetValue: undefined })).toEqual(['bucketEditor.validation.targetRequired']);
  });

  it('holds a percent target to greater than 0 and at most 100', () => {
    expect(issues({ targetValue: 0 })).toEqual(['bucketEditor.validation.percentRange']);
    expect(issues({ targetValue: 100.01 })).toEqual(['bucketEditor.validation.percentRange']);
    expect(issues({ targetValue: 100 })).toEqual([]);
    expect(issues({ targetValue: 0.01 })).toEqual([]);
  });

  it('holds a percent target to two decimals', () => {
    expect(issues({ targetValue: 12.345 })).toEqual(['bucketEditor.validation.percentDecimals']);
    expect(issues({ targetValue: 12.34 })).toEqual([]);
  });

  it('holds an amount target to greater than 0, with no upper bound', () => {
    expect(issues({ targetType: 'AMOUNT', targetValue: 0 })).toEqual(['bucketEditor.validation.amountPositive']);
    expect(issues({ targetType: 'AMOUNT', targetValue: 250000 })).toEqual([]);
  });

  it('refuses a carry cap without carry-over, and a cap that is not positive', () => {
    expect(issues({ carryOver: false, carryCap: 100 })).toEqual(['bucketEditor.validation.capNeedsCarryOver']);
    expect(issues({ carryOver: true, carryCap: 0 })).toEqual(['bucketEditor.validation.capPositive']);
    expect(issues({ carryOver: true, carryCap: 100 })).toEqual([]);
  });
});

describe('normalizeBudgetBucketName / toBudgetBucketDraft', () => {
  it('normalises case and surrounding space only', () => {
    expect(normalizeBudgetBucketName('  Long-Term Goals ')).toBe('long-term goals');
  });

  it('trims the name and drops a cap when carry-over is off', () => {
    expect(
      toBudgetBucketDraft({ name: ' Fun ', targetType: 'AMOUNT', targetValue: 50, carryOver: false, carryCap: 10 }),
    ).toEqual({ name: 'Fun', targetType: 'AMOUNT', targetValue: 50, carryOver: false, carryCap: null });
  });
});

function renderForm(props: Partial<React.ComponentProps<typeof BudgetBucketForm>> = {}) {
  const onSubmit = vi.fn();
  render(
    <BudgetBucketForm currencyCode="USD" otherNames={[]} onSubmit={onSubmit} onCancel={vi.fn()} {...props} />,
  );
  return { onSubmit };
}

async function submit(label = 'Save') {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: label }));
  });
}

describe('BudgetBucketForm', () => {
  it('names every control', () => {
    renderForm();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Target' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Percent of Income', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fixed Amount', pressed: false })).toBeInTheDocument();
    expect(screen.getByLabelText('Percent of Income')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Carry Over What Is Left' })).toBeInTheDocument();
  });

  it('submits a new percent bucket as a draft', async () => {
    const { onSubmit } = renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Needs ' } });
    fireEvent.change(screen.getByLabelText('Percent of Income'), { target: { value: '45.5' } });
    await submit();

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Needs',
      targetType: 'PERCENT',
      targetValue: 45.5,
      carryOver: false,
      carryCap: null,
    });
  });

  it('switching to a fixed amount clears the percent and takes an amount', async () => {
    const { onSubmit } = renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rent' } });
    fireEvent.change(screen.getByLabelText('Percent of Income'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fixed Amount' }));

    expect(screen.queryByLabelText('Percent of Income')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Amount per Period')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('Amount per Period'), { target: { value: '1500' } });
    await submit();

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'AMOUNT', targetValue: 1500 }));
  });

  it('shows the cap only with carry-over on, and turning carry-over off clears it', async () => {
    const { onSubmit } = renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Savings' } });
    fireEvent.change(screen.getByLabelText('Percent of Income'), { target: { value: '20' } });

    expect(screen.queryByLabelText('Carry Cap (optional)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Carry Over What Is Left' }));
    fireEvent.change(screen.getByLabelText('Carry Cap (optional)'), { target: { value: '300' } });

    // Off and on again: the cap typed before does not come back.
    fireEvent.click(screen.getByRole('switch', { name: 'Carry Over What Is Left' }));
    expect(screen.queryByLabelText('Carry Cap (optional)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Carry Over What Is Left' }));
    expect(screen.getByLabelText('Carry Cap (optional)')).toHaveValue('');

    await submit();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ carryOver: true, carryCap: null }));
  });

  it('submits a cap with carry-over on', async () => {
    const { onSubmit } = renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Savings' } });
    fireEvent.change(screen.getByLabelText('Percent of Income'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Carry Over What Is Left' }));
    fireEvent.change(screen.getByLabelText('Carry Cap (optional)'), { target: { value: '300' } });
    await submit();

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ carryOver: true, carryCap: 300 }));
  });

  it('loads the bucket it edits and saves it back unchanged', async () => {
    const bucket = { name: 'Fun', targetType: 'AMOUNT' as const, targetValue: 75, carryOver: true, carryCap: 200 };
    const { onSubmit } = renderForm({ bucket });

    expect(screen.getByLabelText('Name')).toHaveValue('Fun');
    expect(screen.getByRole('button', { name: 'Fixed Amount', pressed: true })).toBeInTheDocument();
    await submit('Save Changes');

    expect(onSubmit).toHaveBeenCalledWith(bucket);
  });

  it('shows each refusal on its field and submits nothing', async () => {
    const { onSubmit } = renderForm({ otherNames: ['Savings'] });
    await submit();
    expect(screen.getByText('Enter a name')).toBeInTheDocument();
    expect(screen.getByText('Enter a target')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x'.repeat(51) } });
    fireEvent.change(screen.getByLabelText('Percent of Income'), { target: { value: '150' } });
    await submit();
    expect(screen.getByText('A name can be at most 50 characters')).toBeInTheDocument();
    expect(screen.getByText('A percent target must be greater than 0 and at most 100')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' savings' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fixed Amount' }));
    fireEvent.change(screen.getByLabelText('Amount per Period'), { target: { value: '0' } });
    await submit();
    expect(screen.getByText('Another bucket already has this name')).toBeInTheDocument();
    expect(screen.getByText('An amount target must be greater than 0')).toBeInTheDocument();

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
