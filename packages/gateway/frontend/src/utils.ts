/** Shared utility functions and constants */

/** Short display length for abstract session IDs */
export const SESSION_ID_SHORT = 8;

/** Short display length for SDK (physical) session IDs */
export const SDK_SESSION_ID_SHORT = 12;

/** Format an ISO timestamp as a human-readable elapsed time string */
export function elapsed(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return "--";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
