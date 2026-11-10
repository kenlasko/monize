'use client';

import { useEffect, useState } from 'react';

/**
 * A callback ref, and the current size of the element it lands on; zero for
 * both while it has none.
 */
export function useElementSize<T extends HTMLElement>(): [
  (node: T | null) => void,
  { width: number; height: number },
] {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!node) return;
    const observer = new ResizeObserver(() => setSize({ width: node.offsetWidth, height: node.offsetHeight }));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [setNode, node ? size : { width: 0, height: 0 }];
}
