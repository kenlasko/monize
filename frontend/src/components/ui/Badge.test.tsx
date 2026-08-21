import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { Badge } from './Badge';

describe('Badge', () => {
  it('renders its children in a pill', () => {
    render(<Badge>Pending</Badge>);
    const badge = screen.getByText('Pending');
    expect(badge.className).toContain('rounded-full');
    expect(badge.className).toContain('font-medium');
  });

  it('defaults to a neutral span at the small size', () => {
    render(<Badge>3</Badge>);
    const badge = screen.getByText('3');
    expect(badge.tagName).toBe('SPAN');
    expect(badge.className).toContain('bg-gray-100');
    expect(badge.className).toContain('text-xs');
  });

  it('carries both light and dark colours for every variant', () => {
    // A variant that styles only one mode is invisible in the other, which is
    // the failure mode of a hand-rolled pill.
    for (const variant of ['gray', 'blue', 'green', 'red', 'amber', 'purple'] as const) {
      const { unmount } = render(<Badge variant={variant}>{variant}</Badge>);
      const className = screen.getByText(variant).className;
      expect(className, `${variant} light background`).toMatch(/(?<!dark:)bg-\w+-100/);
      expect(className, `${variant} dark background`).toMatch(/dark:bg-\w+-\d00/);
      expect(className, `${variant} dark text`).toMatch(/dark:text-\w+-200/);
      unmount();
    }
  });

  it('stays on the theme ramps, so the colour themes re-skin it', () => {
    // A literal hex or an off-ramp hue would look right on the default palette
    // and stay that colour on all fifteen.
    render(<Badge variant="blue">Accent</Badge>);
    expect(screen.getByText('Accent').className).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it('renders as a button when the badge is also a control', () => {
    // Nesting a button inside a span-badge would put an interactive element
    // inside a click target; `as` keeps them one element.
    const onClick = vi.fn();
    render(
      <Badge as="button" type="button" onClick={onClick}>
        Transfer
      </Badge>,
    );
    const badge = screen.getByRole('button', { name: 'Transfer' });
    fireEvent.click(badge);
    expect(onClick).toHaveBeenCalled();
  });

  it('lets a call site add classes without losing the base ones', () => {
    render(<Badge className="ml-2">Tagged</Badge>);
    const badge = screen.getByText('Tagged');
    expect(badge.className).toContain('ml-2');
    expect(badge.className).toContain('rounded-full');
  });
});
