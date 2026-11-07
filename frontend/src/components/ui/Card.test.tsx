import { describe, it, expect } from 'vitest';
import { render } from '@/test/render';
import { Card, CARD_CLASS } from './Card';

describe('Card', () => {
  it('renders children inside the shared card surface', () => {
    const { getByText, container } = render(<Card>hello</Card>);
    expect(getByText('hello')).toBeInTheDocument();
    const root = container.firstElementChild as HTMLElement;
    for (const cls of CARD_CLASS.split(/\s+/)) {
      expect(root.classList.contains(cls)).toBe(true);
    }
  });

  it('defaults to no padding so table shells stay flush', () => {
    const { container } = render(<Card>x</Card>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toMatch(/\bp-4\b|\bp-3\b/);
  });

  it.each([
    ['sm', 'p-3 sm:p-4'],
    ['md', 'p-4 sm:p-6'],
  ] as const)('applies %s padding', (padding, expected) => {
    const { container } = render(<Card padding={padding}>x</Card>);
    const root = container.firstElementChild as HTMLElement;
    for (const cls of expected.split(/\s+/)) {
      expect(root.classList.contains(cls)).toBe(true);
    }
  });

  it('renders as the requested element and forwards props', () => {
    const { container } = render(
      <Card as="section" aria-label="Summary" data-testid="card">
        x
      </Card>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe('SECTION');
    expect(root.getAttribute('aria-label')).toBe('Summary');
    expect(root.getAttribute('data-testid')).toBe('card');
  });

  it('merges a caller className after the base classes', () => {
    const { container } = render(<Card className="mb-6 rounded-xl">x</Card>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains('mb-6')).toBe(true);
    // twMerge resolves the radius conflict in favour of the caller.
    expect(root.classList.contains('rounded-xl')).toBe(true);
    expect(root.classList.contains('rounded-lg')).toBe(false);
  });

  it('lights the dark card from above instead of wearing the old light glow', () => {
    const classes = CARD_CLASS.split(/\s+/);
    expect(classes).toContain('dark:shadow-card-dark');
    expect(classes).not.toContain('dark:shadow-gray-700/50');
  });
});
