import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '@/test/render';
import { PayeeLookupSection } from './PayeeLookupSection';
import type { PayeeLookupSettings } from '@/types/payee-lookup';

vi.mock('@/lib/ai', () => ({
  aiApi: { getConfigs: vi.fn() },
}));

vi.mock('@/lib/payee-lookup', () => ({
  payeeLookupApi: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    testKey: vi.fn(),
    getStatus: vi.fn(),
  },
}));

const refreshAvailability = vi.fn(async () => {});

const availability = {
  available: true,
  resolved: true,
  failed: false,
  source: 'google-places' as const,
  aiConfigured: false,
  refresh: refreshAvailability,
};

vi.mock('@/hooks/useContactLookupAvailable', () => ({
  useContactLookupAvailable: () => availability,
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({
      preferences: { payeeContactLookupEnabled: false },
      updatePreferences: vi.fn(),
    }),
}));

import { payeeLookupApi } from '@/lib/payee-lookup';

import { aiApi } from '@/lib/ai';

const getConfigs = aiApi.getConfigs as unknown as Mock;
const getSettings = payeeLookupApi.getSettings as unknown as Mock;
const updateSettings = payeeLookupApi.updateSettings as unknown as Mock;

const settings = (over: Partial<PayeeLookupSettings> = {}): PayeeLookupSettings => ({
  mode: 'none',
  configured: false,
  enabled: true,
  aiEnabled: true,
  capEnabled: true,
  monthlyCap: 1000,
  apiKeyMasked: null,
  apiKeyReadable: true,
  usedThisMonth: 0,
  preferredSource: 'google-places',
  aiProviderConfigId: null,
  encryptionAvailable: true,
  ...over,
});

async function renderSection() {
  await act(async () => {
    render(<PayeeLookupSection />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  availability.aiConfigured = false;
  availability.available = true;
  availability.failed = false;
  availability.refresh = refreshAvailability;
  getConfigs.mockResolvedValue([]);
  getSettings.mockResolvedValue(settings());
  updateSettings.mockImplementation(async (patch) =>
    settings({ ...patch, configured: Boolean(patch.apiKey) }),
  );
});

describe('PayeeLookupSection', () => {
  it('invites an unconfigured user to set Google Places up', async () => {
    await renderSection();

    expect(screen.getByText('Google Places')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove key' }),
    ).not.toBeInTheDocument();
  });

  it('shows the month usage against the cap once a key is stored', async () => {
    getSettings.mockResolvedValue(
      settings({
        mode: 'user',
        configured: true,
        apiKeyMasked: '****',
        usedThisMonth: 42,
        monthlyCap: 1000,
      }),
    );

    await renderSection();

    expect(screen.getByText(/Used this month: 42 of 1,?000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('says the count is unlimited rather than printing a cap nobody set', async () => {
    getSettings.mockResolvedValue(
      settings({
        mode: 'user',
        configured: true,
        capEnabled: false,
        usedThisMonth: 9,
      }),
    );

    await renderSection();

    expect(screen.getByText(/No monthly limit/)).toBeInTheDocument();
  });

  describe('in operator mode', () => {
    const operator = settings({
      mode: 'operator',
      configured: true,
      monthlyCap: 5000,
    });

    it('offers the switch but no key or cap controls', async () => {
      // The deployment's key is already paid for; a key field beside it would
      // invite the user to pay twice for one lookup.
      getSettings.mockResolvedValue(operator);

      await renderSection();

      // Named, because the automatic-lookup toggle renders its own switch
      // below this card.
      expect(
        screen.getByRole('switch', {
          name: 'Use Google Places for payee lookups',
        }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Set up' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Edit' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Remove key' }),
      ).not.toBeInTheDocument();
    });

    it('says who configured it', async () => {
      getSettings.mockResolvedValue(operator);

      await renderSection();

      expect(screen.getByText(/administrator/)).toBeInTheDocument();
    });
  });

  it('saves the switch as it changes and reverts on failure', async () => {
    getSettings.mockResolvedValue(
      settings({ mode: 'user', configured: true, apiKeyMasked: '****' }),
    );
    updateSettings.mockRejectedValue(new Error('nope'));

    await renderSection();
    const toggle = screen.getByRole('switch', {
      name: 'Use Google Places for payee lookups',
    });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({ enabled: false });
    });
    // The save failed, so the switch goes back to what it actually is.
    await waitFor(() => {
      expect(
        screen.getByRole('switch', {
          name: 'Use Google Places for payee lookups',
        }),
      ).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('clears the stored key with an empty string, never by omitting it', async () => {
    // An absent apiKey means "keep what is stored"; only "" removes it.
    getSettings.mockResolvedValue(
      settings({ mode: 'user', configured: true, apiKeyMasked: '****' }),
    );

    await renderSection();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    });

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({ apiKey: '' });
    });
  });

  it('warns when the server cannot store a key, and does not offer to take one', async () => {
    getSettings.mockResolvedValue(settings({ encryptionAvailable: false }));

    await renderSection();

    expect(screen.getByText(/no encryption key configured/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up' })).toBeDisabled();
  });

  it('distinguishes an unreadable stored key from having none', async () => {
    // Different repair: enter it again, rather than for the first time.
    getSettings.mockResolvedValue(
      settings({
        mode: 'user',
        configured: true,
        apiKeyMasked: '****',
        apiKeyReadable: false,
      }),
    );

    await renderSection();

    expect(screen.getByText(/cannot be read by this server/)).toBeInTheDocument();
  });

  it('reports a failed load instead of rendering the empty state', async () => {
    // Rendering "not configured" would invite the user to enter a key they may
    // already have stored.
    getSettings.mockRejectedValue(new Error('offline'));

    await renderSection();

    expect(screen.getByText(/Could not load/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Set up' }),
    ).not.toBeInTheDocument();
  });

  /**
   * One section, not two. The automatic-lookup switch used to be its own card
   * under its own heading, which read as a second feature about the same thing;
   * it now lives inside Payee Lookup and draws no heading of its own.
   */
  it('renders the automatic-lookup switch inside the one Payee Lookup section', async () => {
    await renderSection();

    // Exactly one heading for the whole feature.
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(['Payee Lookup']);
    expect(
      screen.getByText('Automatic payee contact lookup'),
    ).toBeInTheDocument();
  });

  it('links to the setup instructions only until a key exists', async () => {
    await renderSection();

    // Getting a key is a Google Cloud errand with a step that is easy to get
    // wrong, so the link is offered while it is still needed.
    const link = screen.getByRole('link', { name: 'Setup instructions' });
    expect(link).toHaveAttribute(
      'href',
      'https://www.monize.net/docs/categories-and-payees#setting-up-google-places',
    );

    getSettings.mockResolvedValue(settings({ mode: 'user', configured: true }));
    await renderSection();
    expect(
      screen.queryAllByRole('link', { name: 'Setup instructions' }),
    ).toHaveLength(1);
  });

  describe('choosing which source answers first', () => {
    it('does not draw the AI row at all when no provider is configured', async () => {
      // Nothing to switch on and nothing to order, so the row is absent rather
      // than present-and-inert: an empty row offering a dead switch would be a
      // control whose only outcome is "go and configure something else".
      getSettings.mockResolvedValue(
        settings({ mode: 'user', configured: true }),
      );
      await renderSection();

      const rows = screen.getAllByRole('listitem');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveTextContent('Google Places');
      expect(screen.queryByText('AI provider')).not.toBeInTheDocument();
    });

    it('withholds the moving, not the rows, when only one source can answer', async () => {
      // Both rows drawn (a provider exists) but Places has no key, so ordering
      // would imply a fallback that does not exist. The rows still render --
      // they are where Places is CONFIGURED -- and only the arrows go dead.
      availability.aiConfigured = true;
      await renderSection();

      expect(screen.getAllByRole('listitem')).toHaveLength(2);
      for (const button of [
        ...screen.getAllByRole('button', { name: 'Move up' }),
        ...screen.getAllByRole('button', { name: 'Move down' }),
      ]) {
        expect(button).toBeDisabled();
      }
      // The rows are still where Places gets its key, so they stay reachable.
      expect(
        screen.getByRole('button', { name: 'Set up' }),
      ).toBeInTheDocument();
    });

    it('offers the ordering once both sources are configured', async () => {
      availability.aiConfigured = true;
      getSettings.mockResolvedValue(
        settings({ mode: 'user', configured: true }),
      );
      await renderSection();

      expect(screen.getByText('Which source answers first')).toBeInTheDocument();
      // Google Places first by default, so it is the row that cannot move up.
      const rows = screen.getAllByRole('listitem');
      expect(rows[0]).toHaveTextContent('Google Places');
      expect(rows[1]).toHaveTextContent('Existing AI Provider');
    });

    it('saves the new order and never resends the key alongside it', async () => {
      availability.aiConfigured = true;
      getSettings.mockResolvedValue(
        settings({ mode: 'user', configured: true }),
      );
      await renderSection();

      await act(async () => {
        // Moving either row is the same move in a two-item list.
        fireEvent.click(screen.getAllByRole('button', { name: 'Move up' })[1]);
      });

      await waitFor(() => expect(updateSettings).toHaveBeenCalled());
      // Only the field that changed. An apiKey of '' would DELETE the stored
      // key, so a patch that carried one would silently destroy it.
      expect(updateSettings).toHaveBeenCalledWith({ preferredSource: 'ai' });
    });

    it('offers a provider choice only when there is more than one', async () => {
      availability.aiConfigured = true;
      getSettings.mockResolvedValue(
        settings({ mode: 'user', configured: true }),
      );
      // One provider is not a choice: the control would carry a single option.
      getConfigs.mockResolvedValue([
        { id: 'a', provider: 'anthropic', displayName: null, model: null, isActive: true },
      ]);
      await renderSection();

      expect(screen.queryByLabelText('Provider to use')).not.toBeInTheDocument();
    });

    it('pins the chosen provider, and offers only the active ones', async () => {
      availability.aiConfigured = true;
      getSettings.mockResolvedValue(
        settings({ mode: 'user', configured: true }),
      );
      getConfigs.mockResolvedValue([
        { id: 'a', provider: 'anthropic', displayName: 'Claude', model: 'opus', isActive: true },
        { id: 'b', provider: 'openai', displayName: null, model: null, isActive: true },
        // Inactive: pinning it would report no_provider on every lookup.
        { id: 'c', provider: 'ollama', displayName: 'Local', model: null, isActive: false },
      ]);
      await renderSection();

      const select = screen.getByLabelText('Provider to use');
      expect(screen.queryByRole('option', { name: 'Local' })).not.toBeInTheDocument();
      // The model is part of the name: two rows of one vendor differ only by it.
      expect(screen.getByRole('option', { name: 'Claude (opus)' })).toBeInTheDocument();

      await act(async () => {
        fireEvent.change(select, { target: { value: 'a' } });
      });

      await waitFor(() =>
        expect(updateSettings).toHaveBeenCalledWith({ aiProviderConfigId: 'a' }),
      );
    });

    it('clears the pin back to no preference', async () => {
      availability.aiConfigured = true;
      getSettings.mockResolvedValue(
        settings({ mode: 'user', configured: true, aiProviderConfigId: 'a' }),
      );
      getConfigs.mockResolvedValue([
        { id: 'a', provider: 'anthropic', displayName: 'Claude', model: null, isActive: true },
        { id: 'b', provider: 'openai', displayName: null, model: null, isActive: true },
      ]);
      await renderSection();

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Provider to use'), {
          target: { value: '' },
        });
      });

      // null, not '': the empty option means "no preference", and the server
      // reads null as clearing the pin.
      await waitFor(() =>
        expect(updateSettings).toHaveBeenCalledWith({ aiProviderConfigId: null }),
      );
    });
  });

  /**
   * One section, not two. The Google Places key, its switch and the source
   * order used to be separate blocks stacked in one card, which asked the
   * reader to hold one feature in two places and made the order read as a
   * footnote to the key. Everything a source needs now sits on that source's
   * own row.
   */
  describe('as one combined section', () => {
    it('puts the Google Places controls inside its row in the order list', async () => {
      availability.aiConfigured = true;
      getSettings.mockResolvedValue(
        settings({ mode: 'user', configured: true }),
      );
      await renderSection();

      const [placesRow] = screen.getAllByRole('listitem');
      expect(placesRow).toHaveTextContent('Google Places');
      // The key management and the on/off switch, on the row itself.
      expect(
        within(placesRow).getByRole('button', { name: 'Edit' }),
      ).toBeInTheDocument();
      expect(
        within(placesRow).getByRole('button', { name: 'Remove key' }),
      ).toBeInTheDocument();
      expect(
        within(placesRow).getByRole('switch', {
          name: 'Use Google Places for payee lookups',
        }),
      ).toBeInTheDocument();
    });

    it("puts each source's switch on its title line, not among its controls", async () => {
      // Position is the claim, and nothing else in the suite can see it: the
      // switch reads as the row's primary state only while it sits beside the
      // name it applies to. Below the description it looked like one more of
      // the row's settings.
      availability.aiConfigured = true;
      getConfigs.mockResolvedValue([
        { id: 'a', provider: 'anthropic', displayName: null, model: null, isActive: true },
        { id: 'b', provider: 'openai', displayName: null, model: null, isActive: true },
      ]);
      getSettings.mockResolvedValue(
        settings({ mode: 'user', configured: true }),
      );
      await renderSection();

      const [placesRow, aiRow] = screen.getAllByRole('listitem');

      const places = within(placesRow).getByRole('switch', {
        name: 'Use Google Places for payee lookups',
      }).parentElement!;
      expect(places).toHaveTextContent('Google Places');
      // The controls below it are a sibling block, not this line.
      expect(
        within(places).queryByRole('button', { name: 'Edit' }),
      ).not.toBeInTheDocument();

      const ai = within(aiRow).getByRole('switch', {
        name: 'Use an AI provider for payee lookups',
      }).parentElement!;
      expect(ai).toHaveTextContent('Existing AI Provider');
      expect(
        within(ai).queryByRole('combobox', { name: 'Provider to use' }),
      ).not.toBeInTheDocument();
    });

    it('offers setup and its instructions on the row before a key exists', async () => {
      await renderSection();

      const [placesRow] = screen.getAllByRole('listitem');
      expect(
        within(placesRow).getByRole('button', { name: 'Set up' }),
      ).toBeInTheDocument();
      expect(
        within(placesRow).getByRole('link', { name: 'Setup instructions' }),
      ).toBeInTheDocument();
      expect(
        within(placesRow).queryByRole('button', { name: 'Remove key' }),
      ).not.toBeInTheDocument();
    });

    it('draws one heading for the whole feature', async () => {
      availability.aiConfigured = true;
      getSettings.mockResolvedValue(
        settings({ mode: 'user', configured: true }),
      );
      await renderSection();

      // The Google Places sub-heading is gone: the row's own title carries it.
      expect(
        screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent),
      ).toEqual(['Payee Lookup']);
    });

    it('still saves the switch from inside the row', async () => {
      getSettings.mockResolvedValue(
        settings({ mode: 'user', configured: true }),
      );
      await renderSection();

      const [placesRow] = screen.getAllByRole('listitem');
      await act(async () => {
        fireEvent.click(
          within(placesRow).getByRole('switch', {
            name: 'Use Google Places for payee lookups',
          }),
        );
      });

      await waitFor(() =>
        expect(updateSettings).toHaveBeenCalledWith({ enabled: false }),
      );
    });
  });

  /**
   * Each source has its own switch, and between them they decide whether an
   * automatic lookup can happen at all.
   */
  describe('switching a source off', () => {
    const bothSources = () => {
      availability.aiConfigured = true;
      getSettings.mockResolvedValue(
        settings({ mode: 'user', configured: true }),
      );
    };

    it('saves the AI switch on its own', async () => {
      bothSources();
      await renderSection();

      // Located by the switch rather than by row copy: the Google Places
      // description names the AI provider too, so a textContent match found
      // the wrong row.
      const aiToggle = screen.getByRole('switch', {
        name: 'Use an AI provider for payee lookups',
      });
      // It belongs to the AI row, not to Places' block of controls.
      expect(aiToggle.closest('li')).toBe(
        screen.getAllByRole('listitem').at(1),
      );

      await act(async () => {
        fireEvent.click(aiToggle);
      });

      // Only the field that changed -- an apiKey of '' would delete the key.
      await waitFor(() =>
        expect(updateSettings).toHaveBeenCalledWith({ aiEnabled: false }),
      );
    });

    it('leaves the automatic lookup live while one source is still on', async () => {
      bothSources();
      getSettings.mockResolvedValue(
        settings({ mode: 'user', configured: true, aiEnabled: false }),
      );
      await renderSection();

      // Places is still on, so an automatic lookup still has a source.
      expect(
        screen.getByRole('switch', {
          name: 'Enable automatic payee contact lookup',
        }),
      ).toBeEnabled();
    });

    it('turns the automatic lookup off and disables it when nothing can answer', async () => {
      bothSources();
      // The server's own answer, which folds in a spent cap and an unreadable
      // key as well as the two switches.
      availability.available = false;
      getSettings.mockResolvedValue(
        settings({
          mode: 'user',
          configured: true,
          enabled: false,
          aiEnabled: false,
        }),
      );
      await renderSection();

      const auto = screen.getByRole('switch', {
        name: 'Enable automatic payee contact lookup',
      });
      expect(auto).toBeDisabled();
      expect(auto).toHaveAttribute('aria-checked', 'false');
    });

    it('does not tell the reader to switch a source on when the status read failed', async () => {
      // `available: false` is three states at once. The section may only pass
      // the one it has established: a failed status read with both sources on
      // would otherwise print "switch on a source above" over two switches
      // that are already on, and the reader would go and fix nothing.
      bothSources();
      availability.available = false;
      availability.failed = true;
      await renderSection();

      expect(screen.queryByText(/Switch on a source above/)).toBeNull();
      expect(
        screen.getByRole('switch', {
          name: 'Enable automatic payee contact lookup',
        }),
      ).toBeEnabled();
    });

    it('re-reads whether a lookup can run, before the save reports success', async () => {
      // Switching the last source off is what MAKES a lookup impossible, so a
      // status read from mount would leave the automatic-lookup toggle live
      // over a lookup that can no longer run. Awaited inside the save, so the
      // card is never live against the stale answer.
      bothSources();
      await renderSection();
      refreshAvailability.mockClear();

      await act(async () => {
        fireEvent.click(
          screen.getByRole('switch', {
            name: 'Use Google Places for payee lookups',
          }),
        );
      });

      await waitFor(() => expect(refreshAvailability).toHaveBeenCalled());
      expect(
        refreshAvailability.mock.invocationCallOrder[0],
      ).toBeGreaterThan(updateSettings.mock.invocationCallOrder[0]);
    });
  });
});
