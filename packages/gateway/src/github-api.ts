/**
 * GitHub API client for premium request usage and models catalog.
 * Runs on the gateway process side. Falls back gracefully on error.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AuthConfig } from "./config.js";

export interface PremiumRequestUsageItem {
  product: string;
  sku: string;
  model: string;
  unitType: string;
  pricePerUnit: number;
  grossQuantity: number;
  grossAmount: number;
  discountQuantity: number;
  discountAmount: number;
  netQuantity: number;
  netAmount: number;
}

export interface PremiumRequestUsageResponse {
  timePeriod: { year: number; month: number };
  user: string;
  usageItems: PremiumRequestUsageItem[];
}

export interface GitHubModelEntry {
  id: string;
  name: string;
  publisher?: string;
  summary?: string;
  rateLimitTier?: string;
}

/** Resolve a GitHub token from auth config. Returns null if unavailable. */
function resolveToken(auth: AuthConfig): string | null {
  try {
    if (auth.tokenCommand !== undefined) {
      const parts = auth.tokenCommand.split(/\s+/).filter((p) => p.length > 0);
      if (parts.length === 0) return null;
      const [cmd, ...args] = parts;
      return execFileSync(cmd!, args, { encoding: "utf-8", timeout: 10_000 }).trim() || null;
    }

    if (auth.type === "gh-auth") {
      const args = ["auth", "token"];
      if (auth.user !== undefined) args.push("--user", auth.user);
      if (auth.hostname !== undefined) args.push("--hostname", auth.hostname);
      return execFileSync("gh", args, { encoding: "utf-8", timeout: 10_000 }).trim() || null;
    }

    if (auth.tokenEnv !== undefined) {
      return process.env[auth.tokenEnv] || null;
    }

    if (auth.tokenFile !== undefined) {
      return readFileSync(auth.tokenFile, "utf-8").trim() || null;
    }
  } catch {
    // Token resolution failed — return null to trigger fallback
  }
  return null;
}

/** Resolve the GitHub username from auth config. */
function resolveUsername(auth: AuthConfig): string | null {
  if (auth.user !== undefined) return auth.user;
  // Try to get username from gh CLI
  try {
    const result = execFileSync("gh", ["api", "/user", "--jq", ".login"], {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Fetch premium request usage from GitHub API.
 * Returns null if unavailable (auth not configured, API error, etc.).
 */
export async function fetchPremiumRequestUsage(
  auth: AuthConfig | undefined,
): Promise<PremiumRequestUsageResponse | null> {
  if (auth === undefined) return null;
  const token = resolveToken(auth);
  if (token === null) return null;
  const username = resolveUsername(auth);
  if (username === null) return null;

  try {
    const res = await fetch(
      `https://api.github.com/users/${encodeURIComponent(username)}/settings/billing/premium_request/usage`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
      },
    );
    if (!res.ok) return null;
    const data = await res.json() as PremiumRequestUsageResponse;
    return data;
  } catch {
    return null;
  }
}

/**
 * Fetch model catalog from GitHub Models API.
 * Returns null if unavailable.
 */
export async function fetchGitHubModels(
  auth: AuthConfig | undefined,
): Promise<GitHubModelEntry[] | null> {
  if (auth === undefined) return null;
  const token = resolveToken(auth);
  if (token === null) return null;

  try {
    const res = await fetch("https://models.github.ai/catalog/models", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as GitHubModelEntry[];
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}
