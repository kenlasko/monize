import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { Button, ButtonLink, buttonClassName } from './Button';

describe('Button', () => {
  it('renders children text', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('renders as a button element', () => {
    render(<Button>Submit</Button>);
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
  });

  it('fires onClick handler', () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click</Button>);

    fireEvent.click(screen.getByText('Click'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('is disabled when disabled prop is true', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('is disabled when isLoading is true', () => {
    render(<Button isLoading>Loading</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('shows spinner when isLoading', () => {
    render(<Button isLoading>Loading</Button>);
    // The spinner is an SVG with animate-spin class
    const svg = document.querySelector('svg.animate-spin');
    expect(svg).toBeInTheDocument();
  });

  it('does not show spinner when not loading', () => {
    render(<Button>Normal</Button>);
    const svg = document.querySelector('svg.animate-spin');
    expect(svg).not.toBeInTheDocument();
  });

  it('applies primary variant by default', () => {
    render(<Button>Primary</Button>);
    const button = screen.getByRole('button');
    expect(button.className).toContain('bg-blue-600');
  });

  it('applies danger variant', () => {
    render(<Button variant="danger">Delete</Button>);
    const button = screen.getByRole('button');
    expect(button.className).toContain('bg-red-600');
  });

  it('applies outline variant', () => {
    render(<Button variant="outline">Outline</Button>);
    const button = screen.getByRole('button');
    expect(button.className).toContain('border');
  });

  it('applies size classes', () => {
    render(<Button size="sm">Small</Button>);
    const button = screen.getByRole('button');
    expect(button.className).toContain('px-3');
  });

  it('merges custom className', () => {
    render(<Button className="my-custom-class">Custom</Button>);
    const button = screen.getByRole('button');
    expect(button.className).toContain('my-custom-class');
  });

  it('sinks slightly when pressed, unless disabled or under reduced motion', () => {
    render(<Button>Press</Button>);
    const classes = screen.getByRole('button').className.split(/\s+/);
    expect(classes).toContain('not-disabled:active:scale-[0.98]');
    expect(classes).toContain('motion-reduce:not-disabled:active:scale-100');
    expect(classes).toContain('motion-reduce:transition-none');
  });

  it('forwards ref', () => {
    const ref = vi.fn();
    render(<Button ref={ref}>Ref</Button>);
    expect(ref).toHaveBeenCalled();
  });

  describe('ButtonLink', () => {
    it('is an anchor wearing the button classes', () => {
      render(
        <ButtonLink href="/api/v1/attachments/a-1/download" download="receipt.png" variant="outline" size="sm">
          Download
        </ButtonLink>,
      );
      const link = screen.getByRole('link', { name: 'Download' });
      expect(link).toHaveAttribute('href', '/api/v1/attachments/a-1/download');
      expect(link).toHaveAttribute('download', 'receipt.png');
      expect(link.className).toBe(buttonClassName('outline', 'sm'));
    });

    it('shares its classes with the button', () => {
      render(<Button variant="outline" size="sm">Same</Button>);
      expect(screen.getByRole('button', { name: 'Same' }).className).toBe(
        buttonClassName('outline', 'sm'),
      );
    });
  });
});
