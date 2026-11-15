import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  canReceivePush,
  detectShell,
  opensExternalLinksNatively,
  publishNotificationsToShell,
  pushUnavailableShell,
  receivesNotificationsNatively,
  supportsDeepLinks,
} from './shell';

const mockGetPushSupport = vi.fn();

vi.mock('@/lib/push', () => ({
  getPushSupport: () => mockGetPushSupport(),
}));

describe('shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPushSupport.mockReturnValue({ supported: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.__MONIZE_SHELL__;
    delete window.__MONIZE_SHELL_NOTIFICATIONS__;
    delete window.Capacitor;
  });

  describe('in a browser (no flag)', () => {
    it('is not a shell', () => {
      expect(detectShell()).toBeNull();
      expect(pushUnavailableShell()).toBeNull();
    });

    it('defers canReceivePush to the existing push support check', () => {
      expect(canReceivePush()).toBe(true);
      mockGetPushSupport.mockReturnValue({ supported: false, reason: 'denied' });
      expect(canReceivePush()).toBe(false);
    });

    it('has no native links or deep links', () => {
      expect(opensExternalLinksNatively()).toBe(false);
      expect(supportsDeepLinks()).toBe(false);
    });
  });

  describe('electron', () => {
    beforeEach(() => {
      window.__MONIZE_SHELL__ = { kind: 'electron', version: '1.2.3' };
    });

    it('is detected with its version', () => {
      expect(detectShell()).toEqual({ kind: 'electron', version: '1.2.3' });
    });

    it('cannot receive push whatever the browser feature test says', () => {
      expect(canReceivePush()).toBe(false);
      expect(pushUnavailableShell()).toEqual({ kind: 'electron', version: '1.2.3' });
      expect(mockGetPushSupport).not.toHaveBeenCalled();
    });

    it('opens external links natively and supports deep links', () => {
      expect(opensExternalLinksNatively()).toBe(true);
      expect(supportsDeepLinks()).toBe(true);
    });
  });

  describe('native notifications', () => {
    const snapshot = { identity: 'user-1', rows: [] };

    it('are received in electron once its preload exposes the bridge', () => {
      const publish = vi.fn();
      window.__MONIZE_SHELL__ = { kind: 'electron', version: '1.2.3' };
      window.__MONIZE_SHELL_NOTIFICATIONS__ = { publish };

      expect(receivesNotificationsNatively()).toBe(true);
      // Not push: the push controls still say the window cannot subscribe.
      expect(canReceivePush()).toBe(false);
      publishNotificationsToShell(snapshot);
      expect(publish).toHaveBeenCalledWith(snapshot);
    });

    it('are not claimed by an electron shell without the bridge', () => {
      window.__MONIZE_SHELL__ = { kind: 'electron', version: '1.0.0' };
      expect(receivesNotificationsNatively()).toBe(false);
      window.__MONIZE_SHELL_NOTIFICATIONS__ = { publish: 'not a function' };
      expect(receivesNotificationsNatively()).toBe(false);
      expect(() => publishNotificationsToShell(snapshot)).not.toThrow();
    });

    it('are not claimed by a browser or capacitor even if the key is planted', () => {
      const publish = vi.fn();
      window.__MONIZE_SHELL_NOTIFICATIONS__ = { publish };
      expect(receivesNotificationsNatively()).toBe(false);
      window.__MONIZE_SHELL__ = { kind: 'capacitor', version: '7.0.0' };
      expect(receivesNotificationsNatively()).toBe(false);
      publishNotificationsToShell(snapshot);
      expect(publish).not.toHaveBeenCalled();
    });

    it('never throws into the page when the shell refuses a value', () => {
      window.__MONIZE_SHELL__ = { kind: 'electron', version: '1.2.3' };
      window.__MONIZE_SHELL_NOTIFICATIONS__ = {
        publish: () => {
          throw new Error('could not be cloned');
        },
      };
      expect(() => publishNotificationsToShell(snapshot)).not.toThrow();
    });
  });

  describe('capacitor', () => {
    it('is detected from the flag', () => {
      window.__MONIZE_SHELL__ = { kind: 'capacitor', version: '7.0.0' };
      expect(detectShell()).toEqual({ kind: 'capacitor', version: '7.0.0' });
      expect(canReceivePush()).toBe(false);
    });

    it('is duck-typed from window.Capacitor when the bridge sets no flag', () => {
      window.Capacitor = { isNativePlatform: () => true };
      expect(detectShell()).toEqual({ kind: 'capacitor', version: '' });
      expect(pushUnavailableShell()).not.toBeNull();
      expect(opensExternalLinksNatively()).toBe(false);
      expect(supportsDeepLinks()).toBe(false);
    });

    it('is not a shell when Capacitor reports a non-native platform', () => {
      window.Capacitor = { isNativePlatform: () => false };
      expect(detectShell()).toBeNull();
    });

    it('prefers the flag over the duck type', () => {
      window.__MONIZE_SHELL__ = { kind: 'electron', version: '1' };
      window.Capacitor = { isNativePlatform: () => true };
      expect(detectShell()?.kind).toBe('electron');
    });
  });

  describe('a malformed flag', () => {
    it.each([
      ['a string', 'electron'],
      ['null', null],
      ['an unknown kind', { kind: 'toaster', version: '1' }],
      ['an inherited kind name', { kind: 'toString', version: '1' }],
      ['a missing version', { kind: 'electron' }],
      ['a non-string version', { kind: 'electron', version: 1 }],
    ])('is treated as absent: %s', (_label, flag) => {
      window.__MONIZE_SHELL__ = flag;
      expect(detectShell()).toBeNull();
      expect(canReceivePush()).toBe(true);
    });
  });

  describe('on the server (no window)', () => {
    beforeEach(() => {
      vi.stubGlobal('window', undefined);
    });

    it('is not a shell and cannot receive push', () => {
      expect(detectShell()).toBeNull();
      expect(canReceivePush()).toBe(false);
      expect(opensExternalLinksNatively()).toBe(false);
      expect(supportsDeepLinks()).toBe(false);
      expect(receivesNotificationsNatively()).toBe(false);
      expect(mockGetPushSupport).not.toHaveBeenCalled();
    });
  });
});
