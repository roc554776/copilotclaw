import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAutoScroll } from "../hooks/useAutoScroll";

describe("useAutoScroll", () => {
  it("initializes isAtBottom as true", () => {
    const { result } = renderHook(() => useAutoScroll<HTMLDivElement>());
    expect(result.current.isAtBottomRef.current).toBe(true);
  });

  it("detects when user scrolls away from bottom", () => {
    const { result } = renderHook(() => useAutoScroll<HTMLDivElement>());

    // Simulate a container element with scroll
    const fakeEl = {
      scrollHeight: 1000,
      scrollTop: 500,
      clientHeight: 400,
    } as unknown as HTMLDivElement;

    // Attach the fake element to the ref
    Object.defineProperty(result.current.containerRef, "current", {
      writable: true,
      value: fakeEl,
    });

    act(() => {
      result.current.handleScroll();
    });

    // 1000 - 500 - 400 = 100, which is >= 50 threshold
    expect(result.current.isAtBottomRef.current).toBe(false);
  });

  it("detects when user is at bottom (within threshold)", () => {
    const { result } = renderHook(() => useAutoScroll<HTMLDivElement>());

    const fakeEl = {
      scrollHeight: 1000,
      scrollTop: 570,
      clientHeight: 400,
    } as unknown as HTMLDivElement;

    Object.defineProperty(result.current.containerRef, "current", {
      writable: true,
      value: fakeEl,
    });

    act(() => {
      result.current.handleScroll();
    });

    // 1000 - 570 - 400 = 30, which is < 50 threshold
    expect(result.current.isAtBottomRef.current).toBe(true);
  });

  it("returns containerRef and handleScroll in the hook result", () => {
    const { result } = renderHook(() => useAutoScroll<HTMLDivElement>());

    expect(result.current.containerRef).toBeDefined();
    expect(typeof result.current.handleScroll).toBe("function");
    expect(result.current.isAtBottomRef).toBeDefined();
  });
});
