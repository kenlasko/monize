import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import BillsLayout from './bills/layout';
import InvestmentsLayout from './investments/layout';
import BudgetsLayout from './budgets/layout';
import ReportsLayout from './reports/layout';
import InsightsLayout from './insights/layout';
import AiLayout from './ai/layout';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

// Non-delegate: the guard passes children straight through.
vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ actingAsUserId: null, delegateSections: null }),
}));

describe('section route layouts', () => {
  it('render their children for a non-delegate', () => {
    const layouts = [
      ['bills', BillsLayout],
      ['investments', InvestmentsLayout],
      ['budgets', BudgetsLayout],
      ['reports', ReportsLayout],
      ['insights', InsightsLayout],
      ['ai', AiLayout],
    ] as const;
    for (const [name, Layout] of layouts) {
      const { unmount } = render(<Layout>{<p>{name}-child</p>}</Layout>);
      expect(screen.getByText(`${name}-child`)).toBeInTheDocument();
      unmount();
    }
  });
});
