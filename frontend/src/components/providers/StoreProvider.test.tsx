import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { StoreProvider } from './StoreProvider';

describe('StoreProvider', () => {
  it('renders children after hydration', async () => {
    render(
      <StoreProvider>
        <div data-testid="child-content">Child</div>
      </StoreProvider>,
    );

    // After effect runs, children should be visible
    await waitFor(() => {
      expect(screen.getByTestId('child-content')).toBeInTheDocument();
    });
  });

  it('hides loading state after hydration', async () => {
    render(
      <StoreProvider>
        <div>Child</div>
      </StoreProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    });
  });

  it('renders children text correctly', async () => {
    render(
      <StoreProvider>
        <p>Hello World</p>
      </StoreProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });
  });
});
