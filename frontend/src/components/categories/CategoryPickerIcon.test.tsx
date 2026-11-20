import { describe, it, expect } from 'vitest';
import { render } from '@/test/render';
import { CategoryPickerIcon, categoryPickerIcon, withCategoryIcons } from './CategoryPickerIcon';

const base = { icon: null, color: null, effectiveIcon: null, effectiveColor: null };

describe('CategoryPickerIcon', () => {
  it('draws the effective icon, inherited from a parent, as an svg', () => {
    const { container } = render(
      <CategoryPickerIcon category={{ ...base, effectiveIcon: 'cart', effectiveColor: '#ff0000' }} />,
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('falls back to the colour dot when no icon is set anywhere', () => {
    const { container } = render(
      <CategoryPickerIcon category={{ ...base, effectiveColor: '#00ff00' }} />,
    );
    const dot = container.querySelector('.rounded-full') as HTMLElement;
    expect(dot.style.backgroundColor).toBe('rgb(0, 255, 0)');
  });

  it('keeps its square with neither, so the name stays in the column', () => {
    const { container } = render(<CategoryPickerIcon category={base} size={20} />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.width).toBe('20px');
    expect(box).toHaveAttribute('aria-hidden', 'true');
    expect(box.childElementCount).toBe(0);
  });
});

describe('categoryPickerIcon', () => {
  it('gives a category with an icon or a colour its mark', () => {
    expect(categoryPickerIcon({ ...base, effectiveIcon: 'cart' })).toBeDefined();
    expect(categoryPickerIcon({ ...base, color: '#00ff00' })).toBeDefined();
  });

  it('gives a category with neither no mark, so its row leaves no blank slot', () => {
    expect(categoryPickerIcon(base)).toBeUndefined();
  });
});

describe('withCategoryIcons', () => {
  it('adds an icon to each category row and leaves a placeholder row alone', () => {
    const options = withCategoryIcons(
      [
        { value: '', label: 'Choose' },
        { value: 'c-1', label: 'Groceries' },
      ],
      [{ ...base, id: 'c-1', effectiveIcon: 'cart' }],
    );
    expect(options[0]).toEqual({ value: '', label: 'Choose' });
    expect(options[1].label).toBe('Groceries');
    expect(options[1].icon).toBeDefined();
  });

  it('leaves a category with no icon or colour without an icon key', () => {
    const options = withCategoryIcons(
      [{ value: 'c-1', label: 'Misc' }],
      [{ ...base, id: 'c-1' }],
    );
    expect(options[0]).toEqual({ value: 'c-1', label: 'Misc' });
  });

  it('decorates a hierarchical filter list down its children', () => {
    const options = withCategoryIcons(
      [{ value: 'c-1', label: 'Food', children: [{ value: 'c-2', label: 'Fruit' }] }],
      [
        { ...base, id: 'c-1', effectiveIcon: 'cart' },
        { ...base, id: 'c-2', effectiveColor: '#00ff00' },
      ],
    );
    expect(options[0].icon).toBeDefined();
    expect((options[0].children?.[0] as { icon?: unknown }).icon).toBeDefined();
  });
});
