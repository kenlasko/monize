import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton, CardSkeleton, TableRowSkeleton, TableSkeleton, PageHeaderSkeleton, FilterBarSkeleton, ChartSkeleton } from './LoadingSkeleton';

describe('Skeleton', () => {
  it('renders with animate-pulse', () => {
    const { container } = render(<Skeleton />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('accepts custom className', () => {
    const { container } = render(<Skeleton className="h-4 w-20" />);
    expect(container.querySelector('.h-4.w-20')).toBeInTheDocument();
  });
});

describe('CardSkeleton', () => {
  it('renders', () => {
    const { container } = render(<CardSkeleton />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });
});

describe('TableRowSkeleton', () => {
  it('renders default 5 columns', () => {
    const { container } = render(
      <table><tbody><TableRowSkeleton /></tbody></table>
    );
    expect(container.querySelectorAll('td')).toHaveLength(5);
  });

  it('renders custom column count', () => {
    const { container } = render(
      <table><tbody><TableRowSkeleton columns={3} /></tbody></table>
    );
    expect(container.querySelectorAll('td')).toHaveLength(3);
  });
});

describe('TableSkeleton', () => {
  it('renders table with default rows and columns', () => {
    const { container } = render(<TableSkeleton />);
    expect(container.querySelectorAll('th')).toHaveLength(5);
    expect(container.querySelectorAll('tr')).toHaveLength(6); // 1 header + 5 body
  });
});

describe('PageHeaderSkeleton', () => {
  it('renders', () => {
    const { container } = render(<PageHeaderSkeleton />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });
});

describe('FilterBarSkeleton', () => {
  it('renders', () => {
    const { container } = render(<FilterBarSkeleton />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });
});

describe('ChartSkeleton', () => {
  it('renders', () => {
    const { container } = render(<ChartSkeleton />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });
});
