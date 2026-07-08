import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';

// Control the identity slice WidgetCard reads/writes for its name + description.
const { identityState, updateIdentityMock } = vi.hoisted(() => ({
  identityState: { current: {} as { displayName?: string; description?: string } },
  updateIdentityMock: vi.fn(),
}));
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({
    config: identityState.current,
    updateConfig: updateIdentityMock,
  }),
}));

describe('WidgetCard', () => {
  beforeEach(() => {
    identityState.current = {};
    updateIdentityMock.mockClear();
  });

  it('renders the title and body', () => {
    render(<WidgetCard title="My Widget">body content</WidgetCard>);
    expect(screen.getByText('My Widget')).toBeInTheDocument();
    expect(screen.getByText('body content')).toBeInTheDocument();
  });

  it('omits the settings gear when there are no config controls or widget id', () => {
    render(<WidgetCard title="My Widget">body</WidgetCard>);
    expect(screen.queryByLabelText(/Configure/)).not.toBeInTheDocument();
  });

  it('shows the gear for a widget id even without config controls', () => {
    render(<WidgetCard title="My Widget" widgetId="my-widget">body</WidgetCard>);
    expect(screen.getByLabelText('Configure My Widget')).toBeInTheDocument();
  });

  it('prefers a custom display name over the title and shows the description', () => {
    identityState.current = { displayName: 'Renamed', description: 'My notes' };
    render(<WidgetCard title="My Widget" widgetId="my-widget">body</WidgetCard>);
    expect(screen.getByText('Renamed')).toBeInTheDocument();
    expect(screen.queryByText('My Widget')).not.toBeInTheDocument();
    expect(screen.getByText('My notes')).toBeInTheDocument();
  });

  it('commits a new display name on blur', async () => {
    render(<WidgetCard title="My Widget" widgetId="my-widget">body</WidgetCard>);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Configure My Widget'));
    });
    const nameInput = screen.getByPlaceholderText('My Widget');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Custom name' } });
      fireEvent.blur(nameInput);
    });
    expect(updateIdentityMock).toHaveBeenCalledWith({ displayName: 'Custom name' });
  });

  it('clears the display name override when blurred empty', async () => {
    identityState.current = { displayName: 'Renamed' };
    render(<WidgetCard title="My Widget" widgetId="my-widget">body</WidgetCard>);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Configure My Widget'));
    });
    const nameInput = screen.getByDisplayValue('Renamed');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: '  ' } });
      fireEvent.blur(nameInput);
    });
    expect(updateIdentityMock).toHaveBeenCalledWith({ displayName: undefined });
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
