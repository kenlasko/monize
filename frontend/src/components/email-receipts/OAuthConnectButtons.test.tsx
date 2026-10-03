import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { OAuthConnectButtons } from './OAuthConnectButtons';

const api = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({ emailReceiptsApi: { oauth: api } }));

const assign = vi.fn();
const originalLocation = window.location;

const providers = (google: boolean, microsoft: boolean) => ({ google, microsoft, redirectUri: 'https://app/cb' });

async function renderButtons(value: ReturnType<typeof providers>) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<OAuthConnectButtons providers={value} />);
  });
  return result;
}

describe('OAuthConnectButtons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, assign } });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('offers a button only for a provider the operator configured', async () => {
    await renderButtons(providers(true, false));
    expect(screen.getByRole('button', { name: 'Connect with Google' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect with Microsoft' })).not.toBeInTheDocument();
  });

  it('offers both when both are configured', async () => {
    await renderButtons(providers(true, true));
    expect(screen.getByRole('button', { name: 'Connect with Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect with Microsoft' })).toBeInTheDocument();
  });

  it('renders nothing when neither is configured, so there is no dead control', async () => {
    const { container } = await renderButtons(providers(false, false));
    expect(container).toBeEmptyDOMElement();
  });

  it('starts the flow and sends the browser to the provider', async () => {
    api.start.mockResolvedValue({ authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1' });
    await renderButtons(providers(false, true));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect with Microsoft' }));
    });
    expect(api.start).toHaveBeenCalledWith('microsoft');
    expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1');
  });

  it('says what went wrong and stays usable when the server refuses', async () => {
    api.start.mockRejectedValue({ response: { data: { message: 'Google sign-in is not configured' } } });
    await renderButtons(providers(true, false));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect with Google' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Google sign-in is not configured');
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Connect with Google' })).toBeEnabled();
  });
});
