import { useCallback, useEffect, useRef } from "react";

const THRESHOLD = 50;

/**
 * Position-based auto-scroll hook.
 *
 * If the user is at the bottom of the scrollable container, new content
 * causes auto-follow. If the user has scrolled up, auto-follow is disabled
 * until they scroll back to the bottom.
 */
export function useAutoScroll<T extends HTMLElement>(
  /** Primitive values that signal new content has been added (e.g. `[items.length]`). */
  deps: React.DependencyList = [],
) {
  const containerRef = useRef<T>(null);
  const isAtBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD;
  }, []);

  useEffect(() => {
    if (isAtBottomRef.current) {
      const el = containerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, deps);

  return { containerRef, handleScroll, isAtBottomRef };
}
