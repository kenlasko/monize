import { describe, it, expect } from 'vitest';
import { act, screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';

describe('WidgetCard', () => {
  it('renders the title and body', () => {
    render(<WidgetCard title="My Widget">body content</WidgetCard>);
    expect(screen.getByText('My Widget')).toBeInTheDocument();
    expect(screen.getByText('body content')).toBeInTheDocument();
  });

  it('omits the settings gear when there are no config controls', () => {
    render(<WidgetCard title="My Widget">body</WidgetCard>);
    expect(screen.queryByLabelText(/Configure/)).not.toBeInTheDocument();
  });

  it('opens and closes the settings modal via the gear and Done button', async () => {
    render(
      <WidgetCard title="My Widget" configControls={<div>config body</div>}>
        body
      </WidgetCard>,
    );

    // Controls are not shown until the gear is clicked.
    expect(screen.queryByText('config body')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Configure My Widget'));
    });
    expect(screen.getByText('config body')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Done'));
    });
    expect(screen.queryByText('config body')).not.toBeInTheDocument();
  });

  it('renders headerRight content', () => {
    render(
      <WidgetCard title="My Widget" headerRight={<span>3M</span>}>
        body
      </WidgetCard>,
    );
    expect(screen.getByText('3M')).toBeInTheDocument();
  });
});

describe('WidgetConfigRow', () => {
  it('labels its control', () => {
    render(
      <WidgetConfigRow label="Timeframe">
        <input aria-label="picker" />
      </WidgetConfigRow>,
    );
    expect(screen.getByText('Timeframe')).toBeInTheDocument();
    expect(screen.getByLabelText('picker')).toBeInTheDocument();
  });
});

describe('WidgetMessage', () => {
  it('renders its message', () => {
    render(<WidgetMessage>Nothing here</WidgetMessage>);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });
});
