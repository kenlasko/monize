import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { NotificationPreferencesMatrix } from './NotificationPreferencesMatrix';
import { notifyPushDevicesChanged } from '@/lib/pushDevicesSignal';

const list = vi.fn();
const update = vi.fn();
vi.mock('@/lib/notification-preferences', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notification-preferences')>()),
  notificationPreferencesApi: {
    list: (...a: unknown[]) => list(...a),
    update: (...a: unknown[]) => update(...a),
  },
}));

const listDevices = vi.fn();
const getConfig = vi.fn();
const currentFingerprint = vi.fn();
vi.mock('@/lib/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push')>()),
  pushApi: {
    listDevices: (...a: unknown[]) => listDevices(...a),
    getConfig: (...a: unknown[]) => getConfig(...a),
  },
  // The matrix asks which endpoint THIS browser holds, so it can tell "the
  // account has a live device" from "the machine in front of you has one".
  currentDeviceFingerprint: (...a: unknown[]) => currentFingerprint(...a),
  getPushSupport: () => ({ supported: true }),
}));

// A live web-push device (absent transport reads as webpush); a disabled one;
// and a live UnifiedPush device for the unifiedpush-column test.
const THIS_ENDPOINT = 'aaaa1111';
const liveDevice = {
  id: 'd1',
  disabledAt: null,
  endpointFingerprint: THIS_ENDPOINT,
};
const disabledDevice = {
  id: 'd2',
  disabledAt: '2026-09-01T00:00:00Z',
  endpointFingerprint: THIS_ENDPOINT,
};
const liveUnifiedDevice = {
  id: 'd3',
  disabledAt: null,
  transport: 'unifiedpush',
  endpointFingerprint: 'cccc3333',
};

describe('NotificationPreferencesMatrix', () => {
  const allChannels = { email: true, emailNotification: true, push: true, unifiedpush: true };
  const pushOnly = { email: false, emailNotification: false, push: true, unifiedpush: true };

  beforeEach(() => {
    list.mockReset().mockResolvedValue([
      { category: 'PAYMENTS', email: true, emailNotification: false, push: false, unifiedpush: false, throttleMinutes: 0, supportedChannels: allChannels },
      { category: 'BUDGETS', email: false, emailNotification: true, push: false, unifiedpush: false, throttleMinutes: 15, supportedChannels: allChannels },
      { category: 'SYSTEM', email: false, emailNotification: false, push: false, unifiedpush: false, throttleMinutes: 0, supportedChannels: pushOnly },
    ]);
    update
      .mockReset()
      .mockResolvedValue({ category: 'PAYMENTS', email: false, emailNotification: false, push: false, unifiedpush: false, throttleMinutes: 0 });
    // One live web-push device by default, so the push column is a real control;
    // no UnifiedPush device, so that column self-gates disabled.
    listDevices.mockReset().mockResolvedValue([liveDevice, disabledDevice]);
    // This browser holds the endpoint that live row names, so by default it is
    // already registered and the enable action has nothing to offer.
    currentFingerprint.mockReset().mockResolvedValue(THIS_ENDPOINT);
    getConfig.mockReset().mockResolvedValue({
      enabled: true,
      publicKey: 'BPublicKey',
      configured: true,
      keyUnreadable: false,
    });
  });
  afterEach(() => cleanup());

  async function renderMatrix(emailAvailable = true) {
    await act(async () => {
      render(<NotificationPreferencesMatrix emailAvailable={emailAvailable} />);
    });
    await act(async () => {}); // drain the mount fetches (prefs + devices)
  }

  it('renders every category with its supported channel switches and a cooldown select', async () => {
    await renderMatrix();
    expect(screen.getByText('Bills and scheduled')).toBeInTheDocument();
    expect(screen.getByText('Budgets')).toBeInTheDocument();
    expect(screen.getByText('System alerts')).toBeInTheDocument();
    // In-app is not a column: the bell shows everything and there is nothing to
    // choose, so the sentence above the grid says it instead of a column of
    // permanent ticks spending a sixth of a phone's width.
    expect(screen.queryByText('In-app')).toBeNull();
    expect(screen.queryByText('Always shown in the bell')).toBeNull();
    // report + alert + push + unifiedpush for the two full rows (8), push +
    // unifiedpush only for SYSTEM (2) = 10.
    expect(screen.getAllByRole('switch')).toHaveLength(10);
    // One cooldown select per row.
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
  });

  it('renders SYSTEM as push-only, marking the two email cells not applicable', async () => {
    await renderMatrix();
    // Two email columns x SYSTEM row = two "not applicable" cells; the full rows
    // expose all four channels, so no other cell is marked.
    expect(
      screen.getAllByText('Not applicable for this notification type'),
    ).toHaveLength(2);
    // SYSTEM exposes push and unifiedpush (indices 8, 9). Push self-gates on the
    // live web-push device; unifiedpush is disabled with no UnifiedPush device.
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(10);
    expect(switches[8]).not.toBeDisabled(); // SYSTEM push
    expect(switches[9]).toBeDisabled(); // SYSTEM unifiedpush (no UP device)
    await act(async () => fireEvent.click(switches[8]));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('SYSTEM', { push: true }),
    );
  });

  it('renders the bank sync rows with no report email and the defaults the server sends', async () => {
    // What needs the user's action defaults to immediate email and push; what
    // only reports stays in the bell (docs/specs/bank-sync-notifications.md
    // section 2). The server resolves the defaults, so the grid just shows them.
    const bankSyncChannels = {
      email: false,
      emailNotification: true,
      push: true,
      unifiedpush: true,
    };
    list.mockResolvedValue([
      { category: 'BANK_SYNC', email: true, emailNotification: true, push: true, unifiedpush: false, throttleMinutes: 0, supportedChannels: bankSyncChannels },
      { category: 'BANK_SYNC_ACTIVITY', email: true, emailNotification: false, push: false, unifiedpush: false, throttleMinutes: 0, supportedChannels: bankSyncChannels },
    ]);
    await renderMatrix();

    expect(screen.getByText('Bank connections')).toBeInTheDocument();
    expect(screen.getByText('Bank sync results')).toBeInTheDocument();
    // The report-email cell of each row is not a control.
    expect(
      screen.getAllByText('Not applicable for this notification type'),
    ).toHaveLength(2);
    // Immediate email, push and UnifiedPush for each row.
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(6);
    expect(switches.map((control) => control.getAttribute('aria-checked'))).toEqual([
      'true',
      'true',
      'false',
      'false',
      'false',
      'false',
    ]);
    await act(async () => fireEvent.click(switches[1]));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('BANK_SYNC', { push: false }),
    );
  });

  it('enables the UnifiedPush column only when a UnifiedPush device is live', async () => {
    listDevices.mockResolvedValue([liveDevice, liveUnifiedDevice]);
    await renderMatrix();
    const switches = screen.getAllByRole('switch');
    // PAYMENTS: report(0) alert(1) push(2) unifiedpush(3).
    expect(switches[3]).not.toBeDisabled();
    await act(async () => fireEvent.click(switches[3]));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('PAYMENTS', { unifiedpush: true }),
    );
  });

  it('disables the UnifiedPush column when no UnifiedPush device is live', async () => {
    await renderMatrix();
    // No UnifiedPush device by default -> the column is disabled.
    const switches = screen.getAllByRole('switch');
    expect(switches[3]).toBeDisabled(); // PAYMENTS unifiedpush
  });

  // The two column explanations moved out of the footnote list and onto the
  // columns they explain: a tooltip beside the heading from `md` up, the same
  // sentence inside each of that column's cells below it (where the grid has
  // no column headings to hang a tooltip on).
  it('explains UnifiedPush and the cooldown on the columns themselves', async () => {
    await renderMatrix();
    // Deliberately does NOT open with "UnifiedPush": on a phone the bold column
    // name is printed immediately before it, and a sentence repeating its own
    // subject read "UnifiedPush UnifiedPush delivers through...". It still has
    // to stand alone as the column tooltip, where the heading supplies the
    // subject instead.
    const unifiedpush =
      'Notifications are delivered through a distributor app you run yourself, such as ntfy, instead of a browser vendor\'s push service. Register an endpoint in that app to use this channel.';
    const cooldown =
      'Skip an alert or push when one from the same group fired within this window.';
    // The heading's tooltip carries it as its accessible name...
    expect(
      screen.getByRole('button', { name: unifiedpush }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: cooldown })).toBeInTheDocument();
    // ...and each appears exactly once as rendered text: the footnote a phone
    // gets instead, ONCE, not once per row -- the repetition is what a phone has
    // least room for. The portal variant draws its body only while hovered or
    // focused, so the accessible name above is the whole of the desktop half.
    expect(screen.getAllByText(unifiedpush)).toHaveLength(1);
    expect(screen.getAllByText(cooldown)).toHaveLength(1);
  });

  // The regression: the cooldown `<select>` sizes itself to its WIDEST OPTION
  // and its automatic minimum size is that width, so as a flex item it took
  // what it wanted and every bit of shrinking fell on the label beside it --
  // which, being `min-w-0`, collapsed and let "Cooldown" run underneath the
  // control. Capped and shrinkable, the two share the row.
  it('caps the cooldown control on a phone so its label keeps its space', async () => {
    await renderMatrix();
    for (const select of screen.getAllByRole('combobox')) {
      expect(select.className).toMatch(/\bmax-w-\[[\d.]+rem\]/);
      expect(select.className).toMatch(/\bmin-w-0\b/);
      // ...and neither applies from `md` up, where the column header carries
      // the label and the cell is its own grid track.
      expect(select.className).toMatch(/\bmd:max-w-none\b/);
    }
  });

  it('gates the email columns on email availability', async () => {
    await renderMatrix(false);
    // With email unavailable the report and alert switches are disabled...
    const switches = screen.getAllByRole('switch');
    // Rows render report, alert, push in order; the two email switches per row
    // are disabled, the push one is not (a device is live).
    expect(switches[0]).toBeDisabled(); // PAYMENTS report
    expect(switches[1]).toBeDisabled(); // PAYMENTS alert
    expect(switches[2]).not.toBeDisabled(); // PAYMENTS push
    expect(
      screen.getByText('Turn on email notifications above to send these by email.'),
    ).toBeInTheDocument();
  });

  it('disables the push column and explains why when no device is live', async () => {
    listDevices.mockResolvedValue([disabledDevice]);
    await renderMatrix();
    const switches = screen.getAllByRole('switch');
    expect(switches[2]).toBeDisabled(); // PAYMENTS push
    expect(
      screen.getByText(
        'No device is registered for push, so this channel cannot deliver.',
      ),
    ).toBeInTheDocument();
  });

  // The regression this section was missing: the matrix could say the push
  // column needed a device and offer nothing but a pointer to another panel.
  // The channel is registered per ENDPOINT, so the action belongs here.
  it('offers to register this browser when the account has no live device', async () => {
    listDevices.mockResolvedValue([disabledDevice]);
    await renderMatrix();
    expect(
      screen.getByText('This browser is not registered for push notifications.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Enable on this device' }),
    ).toBeInTheDocument();
  });

  // A working channel elsewhere is not a working channel here: the offer keys
  // off THIS endpoint, never off the account having some live device.
  it('still offers to register this browser when another device is live', async () => {
    listDevices.mockResolvedValue([liveUnifiedDevice]);
    currentFingerprint.mockResolvedValue('bbbb2222');
    await renderMatrix();
    expect(
      screen.getByRole('button', { name: 'Enable on this device' }),
    ).toBeInTheDocument();
  });

  // The other direction of the same seam: removing the last device from the
  // panel below has to re-gate these columns, which were left offering toggles
  // for a channel that could no longer deliver.
  it('re-gates its columns when a registration changes anywhere on the page', async () => {
    await renderMatrix();
    expect(screen.getAllByRole('switch')[2]).not.toBeDisabled(); // PAYMENTS push

    listDevices.mockResolvedValue([disabledDevice]);
    await act(async () => {
      notifyPushDevicesChanged();
    });

    await waitFor(() =>
      expect(screen.getAllByRole('switch')[2]).toBeDisabled(),
    );
  });

  it('offers nothing once this browser is registered', async () => {
    await renderMatrix();
    expect(screen.queryByRole('button', { name: 'Enable on this device' })).toBeNull();
    expect(
      screen.queryByText('This browser is not registered for push notifications.'),
    ).toBeNull();
  });

  // A button that can only fail is worse than no button -- and the sentence
  // beside it must not be left standing on its own either.
  it('offers nothing when this browser cannot receive push at all', async () => {
    getConfig.mockResolvedValue({
      enabled: false,
      publicKey: null,
      configured: false,
      keyUnreadable: false,
    });
    listDevices.mockResolvedValue([disabledDevice]);
    await renderMatrix();
    expect(screen.queryByRole('button', { name: 'Enable on this device' })).toBeNull();
    expect(
      screen.queryByText('This browser is not registered for push notifications.'),
    ).toBeNull();
  });

  it('persists each channel toggle for its category', async () => {
    await renderMatrix();
    const switches = screen.getAllByRole('switch');
    await act(async () => fireEvent.click(switches[0])); // PAYMENTS report on -> off
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('PAYMENTS', { email: false }),
    );
    await act(async () => fireEvent.click(switches[1])); // PAYMENTS alert off -> on
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('PAYMENTS', { emailNotification: true }),
    );
    await act(async () => fireEvent.click(switches[2])); // PAYMENTS push off -> on
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('PAYMENTS', { push: true }),
    );
  });

  it('enables the cooldown only where an interrupting channel is on, and saves the window', async () => {
    await renderMatrix();
    const selects = screen.getAllByRole('combobox');
    // PAYMENTS has neither alert email nor push on -> cooldown disabled.
    expect(selects[0]).toBeDisabled();
    // BUDGETS has alert email on -> cooldown editable.
    expect(selects[1]).not.toBeDisabled();
    await act(async () =>
      fireEvent.change(selects[1], { target: { value: '60' } }),
    );
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('BUDGETS', { throttleMinutes: 60 }),
    );
  });

  it('reverts the toggle when the save fails', async () => {
    update.mockRejectedValue(new Error('boom'));
    await renderMatrix();
    const paymentsReport = screen.getAllByRole('switch')[0];
    expect(paymentsReport.getAttribute('aria-checked')).toBe('true');
    await act(async () => fireEvent.click(paymentsReport));
    await act(async () => {}); // drain the rejection handler
    await waitFor(() =>
      expect(paymentsReport.getAttribute('aria-checked')).toBe('true'),
    );
  });
});
