/** A set of change listeners: `subscribe` returns its own unsubscribe, `notify` calls each one. */
export interface ListenerSet {
  subscribe: (listener: () => void) => () => void;
  notify: () => void;
}

/**
 * A pub/sub list for module state that components follow, in the shape
 * `useSyncExternalStore` takes for its `subscribe`.
 */
export function createListenerSet(): ListenerSet {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify: () => {
      listeners.forEach((listener) => listener());
    },
  };
}
