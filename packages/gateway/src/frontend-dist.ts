import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));

export const FRONTEND_DIST_DIR = resolve(thisDir, "..", "frontend-dist");
const FRONTEND_INDEX_PATH = join(FRONTEND_DIST_DIR, "index.html");
const HAS_FRONTEND = existsSync(FRONTEND_INDEX_PATH);

/** Cached index.html content, read once at startup. */
export const FRONTEND_INDEX_HTML = HAS_FRONTEND ? readFileSync(FRONTEND_INDEX_PATH, "utf-8") : "";

/** Whether the React SPA frontend-dist is available. */
export function hasFrontendDist(): boolean { return HAS_FRONTEND; }

/** Check if a resolved path is within FRONTEND_DIST_DIR (path traversal guard). */
export function isWithinFrontendDist(resolvedPath: string): boolean {
  return resolvedPath.startsWith(FRONTEND_DIST_DIR + sep);
}
