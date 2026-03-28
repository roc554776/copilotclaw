import { useCallback, useEffect, useRef } from "react";

/**
 * Position-based auto-scroll hook.
 *
 * If the user is at the bottom of the scrollable container, new content
 * causes auto-follow. If the user has scrolled up, auto-follow is disabled
 * until they scroll back to the bottom.
 */
export function useAutoScroll<T extends HTMLElement>(deps: unknown[] = []) {
  const containerRef = useRef<T>(null);
  const isAtBottomRef = useRef(true);

  const THRESHOLD = 50;

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { containerRef, handleScroll, scrollToBottom, isAtBottomRef };
}
