import { render, RenderOptions } from '@testing-library/react';
import { ReactElement } from 'react';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { TestIntlProvider } from '@/test/intl';

function AllProviders({ children }: { children: React.ReactNode }) {
  return (
    <TestIntlProvider>
      <ThemeProvider>{children}</ThemeProvider>
    </TestIntlProvider>
  );
}

function customRender(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
) {
  return render(ui, { wrapper: AllProviders, ...options });
}

export * from '@testing-library/react';
export { customRender as render };
