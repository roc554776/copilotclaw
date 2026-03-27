import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Auth config for profile-specific Copilot credentials.
 *  Intentionally duplicated from @copilotclaw/gateway's AuthConfig
 *  to keep the two process packages self-contained. If you change
 *  this interface, apply the same change to gateway/src/config.ts. */
export interface AuthConfig {
  type: "gh-auth" | "pat" | "oauth";
  user?: string;
  hostname?: string;
  tokenEnv?: string;
  tokenFile?: string;
  tokenCommand?: string;
}

/**
 * Resolve a GitHub token from auth config.
 * Returns undefined if auth is not configured (use default SDK auth).
 * Throws on misconfiguration (e.g., missing env var, unreadable file).
 */
export function resolveToken(auth: AuthConfig): string {
  // tokenCommand takes precedence — fully custom token acquisition
  if (auth.tokenCommand !== undefined) {
    return executeTokenCommand(auth.tokenCommand);
  }

  switch (auth.type) {
    case "gh-auth":
      return resolveGhAuthToken(auth);
    case "pat":
    case "oauth":
      return resolveIndirectToken(auth);
    default:
      throw new Error(`unsupported auth type: ${String(auth.type)}`);
  }
}

function resolveGhAuthToken(auth: AuthConfig): string {
  const args = ["auth", "token"];
  if (auth.user !== undefined) {
    args.push("--user", auth.user);
  }
  if (auth.hostname !== undefined) {
    args.push("--hostname", auth.hostname);
  }
  try {
    const token = execFileSync("gh", args, { encoding: "utf-8", timeout: 10_000 }).trim();
    if (token.length === 0) {
      throw new Error("gh auth token returned empty output");
    }
    return token;
  } catch (err: unknown) {
    if (err instanceof Error && "status" in err) {
      throw new Error(`gh auth token failed (exit ${(err as { status: number }).status}): ${err.message}`);
    }
    throw err;
  }
}

function resolveIndirectToken(auth: AuthConfig): string {
  if (auth.tokenEnv !== undefined) {
    const token = process.env[auth.tokenEnv];
    if (token === undefined || token === "") {
      throw new Error(`auth.tokenEnv "${auth.tokenEnv}" is not set or empty`);
    }
    return token;
  }

  if (auth.tokenFile !== undefined) {
    try {
      const token = readFileSync(auth.tokenFile, "utf-8").trim();
      if (token.length === 0) {
        throw new Error(`auth.tokenFile "${auth.tokenFile}" is empty`);
      }
      return token;
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`auth.tokenFile "${auth.tokenFile}" not found`);
      }
      throw err;
    }
  }

  throw new Error(`auth type "${auth.type}" requires tokenEnv, tokenFile, or tokenCommand`);
}

function executeTokenCommand(command: string): string {
  // Use execFileSync with simple space-based splitting to avoid shell injection.
  // Limitation: paths with spaces are not supported (e.g., "/path with spaces/cmd").
  const parts = command.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error("auth.tokenCommand is empty");
  }
  const [cmd, ...args] = parts;
  try {
    const token = execFileSync(cmd!, args, { encoding: "utf-8", timeout: 10_000 }).trim();
    if (token.length === 0) {
      throw new Error(`tokenCommand "${command}" returned empty output`);
    }
    return token;
  } catch (err: unknown) {
    if (err instanceof Error && "status" in err) {
      throw new Error(`tokenCommand "${command}" failed (exit ${(err as { status: number }).status}): ${err.message}`);
    }
    throw err;
  }
}
