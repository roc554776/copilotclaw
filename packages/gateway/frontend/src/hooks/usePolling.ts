import { useEffect, useRef } from "react";

/**
 * Generic polling hook. Calls `callback` immediately, then every
 * `intervalMs` milliseconds. Cleans up on unmount or when deps change.
 */
export function usePolling(callback: () => void, intervalMs: number, enabled = true) {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useEffect(() => {
    if (!enabled) return;

    savedCallback.current();

    const id = setInterval(() => {
      savedCallback.current();
    }, intervalMs);

    return () => clearInterval(id);
  }, [intervalMs, enabled]);
}
