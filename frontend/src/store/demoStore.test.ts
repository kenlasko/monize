import { describe, it, expect, beforeEach } from 'vitest';
import { useDemoStore } from './demoStore';

describe('demoStore', () => {
  beforeEach(() => {
    // Reset store to initial state
    useDemoStore.setState({ isDemoMode: false });
  });

  it('initializes isDemoMode to false', () => {
    expect(useDemoStore.getState().isDemoMode).toBe(false);
  });

  it('sets isDemoMode to true', () => {
    useDemoStore.getState().setDemoMode(true);
    expect(useDemoStore.getState().isDemoMode).toBe(true);
  });

  it('sets isDemoMode back to false', () => {
    useDemoStore.getState().setDemoMode(true);
    useDemoStore.getState().setDemoMode(false);
    expect(useDemoStore.getState().isDemoMode).toBe(false);
  });

  it('exposes setDemoMode as a function', () => {
    expect(typeof useDemoStore.getState().setDemoMode).toBe('function');
  });
});
