import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@/test/render';
import { ServiceWorkerRegistrar } from './ServiceWorkerRegistrar';

describe('ServiceWorkerRegistrar', () => {
  const mockRegister = vi.fn().mockResolvedValue(undefined);
  let originalSW: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalSW = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
  });

  afterEach(() => {
    // Restore serviceWorker property
    if (originalSW) {
      Object.defineProperty(navigator, 'serviceWorker', originalSW);
    } else {
      // If it didn't exist originally, delete it
      delete (navigator as any).serviceWorker;
    }
  });

  it('renders nothing (returns null)', () => {
    const { container } = render(<ServiceWorkerRegistrar />);
    expect(container.innerHTML).toBe('');
  });

  it('registers service worker when available', () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { register: mockRegister },
      configurable: true,
      writable: true,
    });

    render(<ServiceWorkerRegistrar />);
    expect(mockRegister).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('does not call register when serviceWorker is not in navigator', () => {
    // Remove serviceWorker from navigator so 'serviceWorker' in navigator is false
    delete (navigator as any).serviceWorker;

    render(<ServiceWorkerRegistrar />);
    expect(mockRegister).not.toHaveBeenCalled();
  });
});
