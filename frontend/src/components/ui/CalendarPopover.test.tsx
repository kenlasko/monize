import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef } from 'react';
import { fireEvent, screen, act } from '@testing-library/react';
import { render } from '@/test/render';
import { CalendarPopover } from './CalendarPopover';

function Wrapper({
  value,
  onSelect,
  onClose,
}: {
  value: string;
  onSelect: (d: string) => void;
  onClose: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={anchorRef} data-testid="anchor">anchor</div>
      <CalendarPopover value={value} onSelect={onSelect} onClose={onClose} anchorRef={anchorRef} />
    </div>
  );
}

describe('CalendarPopover', () => {
  beforeEach(() => {
    // Stub getBoundingClientRect for the anchor
    Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
      top: 100,
      left: 50,
      bottom: 130,
      right: 100,
      width: 50,
      height: 30,
      x: 50,
      y: 100,
      toJSON: () => ({}),
    });
  });

  it('renders calendar with selected date highlighted', () => {
    render(<Wrapper value="2025-06-15" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Jun 2025')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '15' })).toBeInTheDocument();
  });

  it('navigates to next and previous months', () => {
    render(<Wrapper value="2025-06-15" onSelect={vi.fn()} onClose={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    // First button is the prev arrow, second is the month label, third is the next arrow
    fireEvent.click(buttons[2]);
    expect(screen.getByText('Jul 2025')).toBeInTheDocument();
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[0]);
    // Now should be May 2025
    expect(screen.getByText('May 2025')).toBeInTheDocument();
  });

  it('wraps month from December to January', () => {
    render(<Wrapper value="2025-12-15" onSelect={vi.fn()} onClose={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[2]);
    expect(screen.getByText('Jan 2026')).toBeInTheDocument();
  });

  it('wraps month from January to December (year decrement)', () => {
    render(<Wrapper value="2025-01-15" onSelect={vi.fn()} onClose={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);
    expect(screen.getByText('Dec 2024')).toBeInTheDocument();
  });

  it('selects a day and calls onSelect/onClose', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<Wrapper value="2025-06-15" onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '20' }));
    expect(onSelect).toHaveBeenCalledWith('2025-06-20');
    expect(onClose).toHaveBeenCalled();
  });

  it('toggles to month view and selects a month', () => {
    render(<Wrapper value="2025-06-15" onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Jun 2025'));
    // Now in month view; "Mar" should be a button
    fireEvent.click(screen.getByRole('button', { name: 'Mar' }));
    expect(screen.getByText('Mar 2025')).toBeInTheDocument();
  });

  it('navigates years in month view', () => {
    render(<Wrapper value="2025-06-15" onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Jun 2025'));
    // Now in month view, header label is just "2025"
    expect(screen.getByText('2025')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[2]); // next year
    expect(screen.getByText('2026')).toBeInTheDocument();
    fireEvent.click(buttons[0]); // prev year
    fireEvent.click(buttons[0]);
    expect(screen.getByText('2024')).toBeInTheDocument();
  });

  it('opens the year picker from the month view and selects a year', () => {
    const onSelect = vi.fn();
    render(<Wrapper value="2025-06-15" onSelect={onSelect} onClose={vi.fn()} />);
    // days -> months
    fireEvent.click(screen.getByText('Jun 2025'));
    // months -> years (header now shows just the year)
    fireEvent.click(screen.getByText('2025'));
    // Year grid shows a block of years aligned to the page (2016-2027 for 2025)
    expect(screen.getByText('2016 - 2027')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2025' })).toBeInTheDocument();
    // Pick a different year -> returns to month view for that year
    fireEvent.click(screen.getByRole('button', { name: '2022' }));
    expect(screen.getByText('2022')).toBeInTheDocument();
    // Picking a month then a day yields the chosen year, not the original
    fireEvent.click(screen.getByRole('button', { name: 'Mar' }));
    fireEvent.click(screen.getByRole('button', { name: '10' }));
    expect(onSelect).toHaveBeenCalledWith('2022-03-10');
  });

  it('pages the year grid by a full block with the arrows', () => {
    render(<Wrapper value="2025-06-15" onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Jun 2025'));
    fireEvent.click(screen.getByText('2025'));
    expect(screen.getByText('2016 - 2027')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button');
    // buttons[0] = prev arrow, buttons[2] = next arrow
    fireEvent.click(buttons[2]);
    expect(screen.getByText('2028 - 2039')).toBeInTheDocument();
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[0]);
    expect(screen.getByText('2004 - 2015')).toBeInTheDocument();
  });

  it('cycles the header button back to the day view from the year view', () => {
    render(<Wrapper value="2025-06-15" onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Jun 2025')); // -> months
    fireEvent.click(screen.getByText('2025')); // -> years
    fireEvent.click(screen.getByText('2016 - 2027')); // -> days
    expect(screen.getByText('Jun 2025')).toBeInTheDocument();
  });

  it('handles Clear button', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<Wrapper value="2025-06-15" onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByText('Clear'));
    expect(onSelect).toHaveBeenCalledWith('');
    expect(onClose).toHaveBeenCalled();
  });

  it('handles Today button', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<Wrapper value="2025-06-15" onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByText('Today'));
    expect(onSelect).toHaveBeenCalled();
    const arg = onSelect.mock.calls[0][0];
    expect(arg).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    render(<Wrapper value="2025-06-15" onSelect={vi.fn()} onClose={onClose} />);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on outside click', () => {
    const onClose = vi.fn();
    render(<Wrapper value="2025-06-15" onSelect={vi.fn()} onClose={onClose} />);
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('renders without an initial value (defaults to today)', () => {
    render(<Wrapper value="" onSelect={vi.fn()} onClose={vi.fn()} />);
    // Header should contain the current month/year
    const today = new Date();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    expect(
      screen.getByText(`${months[today.getMonth()]} ${today.getFullYear()}`),
    ).toBeInTheDocument();
  });

  it('clamps position to viewport when anchor is far right', () => {
    Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
      top: 100,
      left: window.innerWidth - 50,
      bottom: 130,
      right: window.innerWidth,
      width: 50,
      height: 30,
      x: window.innerWidth - 50,
      y: 100,
      toJSON: () => ({}),
    });
    render(<Wrapper value="2025-06-15" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Jun 2025')).toBeInTheDocument();
  });

  it('clamps position to viewport when anchor is far left', () => {
    Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
      top: 100,
      left: -100,
      bottom: 130,
      right: -50,
      width: 50,
      height: 30,
      x: -100,
      y: 100,
      toJSON: () => ({}),
    });
    render(<Wrapper value="2025-06-15" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Jun 2025')).toBeInTheDocument();
  });

  it('flips above the anchor when there is not enough room below', () => {
    // Anchor near the bottom of the viewport (jsdom innerHeight is 768)
    Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
      top: 700,
      left: 50,
      bottom: 730,
      right: 100,
      width: 50,
      height: 30,
      x: 50,
      y: 700,
      toJSON: () => ({}),
    });
    render(<Wrapper value="2025-06-15" onSelect={vi.fn()} onClose={vi.fn()} />);
    const popover = document.querySelector('.z-50') as HTMLElement;
    // spaceBelow (38) < height + gap + 8, spaceAbove (700) is larger, so flip up:
    // top = 700 - POPOVER_HEIGHT (340) - 4 = 356
    expect(popover.style.top).toBe('356px');
  });

  it('opens below the anchor when there is room', () => {
    render(<Wrapper value="2025-06-15" onSelect={vi.fn()} onClose={vi.fn()} />);
    const popover = document.querySelector('.z-50') as HTMLElement;
    // Default anchor bottom is 130, plenty of room below: top = 130 + 4 = 134
    expect(popover.style.top).toBe('134px');
  });
});
