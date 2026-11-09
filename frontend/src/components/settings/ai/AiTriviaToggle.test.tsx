import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { act, fireEvent, render, screen } from '@/test/render';
import { AiTriviaToggle } from './AiTriviaToggle';

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: { updatePreferences: vi.fn() },
}));
vi.mock('@/store/preferencesStore', () => ({ usePreferencesStore: vi.fn() }));

import { userSettingsApi } from '@/lib/user-settings';
import { usePreferencesStore } from '@/store/preferencesStore';

const updatePreferencesStore = vi.fn();
let preferences: { aiTriviaEnabled?: boolean } | null;
const save = userSettingsApi.updatePreferences as unknown as Mock;

const flip = () =>
  act(async () => {
    fireEvent.click(screen.getByRole('switch'));
  });

beforeEach(() => {
  vi.clearAllMocks();
  preferences = { aiTriviaEnabled: true };
  (usePreferencesStore as unknown as Mock).mockImplementation((selector: any) =>
    selector({ preferences, updatePreferences: updatePreferencesStore }),
  );
});

describe('AiTriviaToggle', () => {
  it('is a switch, on until a reader turns it off', () => {
    preferences = {};
    render(<AiTriviaToggle />);
    expect(screen.getByRole('switch', { name: 'Show AI trivia on the dashboard' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('shows off when stored off', () => {
    preferences = { aiTriviaEnabled: false };
    render(<AiTriviaToggle />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('saves a change and applies the server answer', async () => {
    const answer = { aiTriviaEnabled: false };
    save.mockResolvedValue(answer);
    render(<AiTriviaToggle />);
    await flip();
    expect(updatePreferencesStore).toHaveBeenNthCalledWith(1, { aiTriviaEnabled: false });
    expect(save).toHaveBeenCalledWith({ aiTriviaEnabled: false });
    expect(updatePreferencesStore).toHaveBeenLastCalledWith(answer);
  });

  it('puts the setting back when the save fails', async () => {
    save.mockRejectedValue(new Error('nope'));
    render(<AiTriviaToggle />);
    await flip();
    expect(updatePreferencesStore).toHaveBeenLastCalledWith({ aiTriviaEnabled: true });
  });

  it('is locked in demo mode', () => {
    render(<AiTriviaToggle disabled />);
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});
