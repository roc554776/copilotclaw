import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { getUpdateDir } from "./workspace.js";

const DEFAULT_UPSTREAM = "https://github.com/roc554776/copilotclaw.git";
const PNPM_VERSION = "10.26.2";

/** Run pnpm via npx so the user doesn't need pnpm globally installed. */
function pnpm(args: string[], cwd: string): string {
  return run(["npx", "-y", `pnpm@${PNPM_VERSION}`, ...args], cwd);
}

function log(message: string): void {
  console.error(`[update] ${message}`);
}

function run(args: string[], cwd: string): string {
  const [cmd, ...rest] = args;
  if (cmd === undefined) throw new Error("run: empty command");
  const result = spawnSync(cmd, rest, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`command failed (exit ${result.status ?? "null"}): ${result.stderr?.trim() ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

/**
 * Rewrite workspace:* dependencies to file: paths in the CLI package.json
 * so that `npm install -g` can resolve them locally.
 */
export function rewriteWorkspaceDeps(cliDir: string, sourceRoot: string): void {
  const pkgPath = join(cliDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
  const deps = pkg["dependencies"] as Record<string, string> | undefined;
  if (deps === undefined) return;

  for (const [name, version] of Object.entries(deps)) {
    if (version.startsWith("workspace:")) {
      // @copilotclaw/gateway → packages/gateway, @copilotclaw/agent → packages/agent
      const shortName = name.replace("@copilotclaw/", "");
      deps[name] = `file:${join(sourceRoot, "packages", shortName)}`;
    }
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

async function main(): Promise<void> {
  const config = loadConfig();
  const upstream = config.upstream ?? DEFAULT_UPSTREAM;
  const updateDir = getUpdateDir();

  log(`upstream: ${upstream}`);

  // Ensure update directory exists with git init
  if (!existsSync(join(updateDir, ".git"))) {
    mkdirSync(updateDir, { recursive: true });
    run(["git", "init"], updateDir);
    log(`initialized source directory: ${updateDir}`);
  }

  // Get current SHA (may be empty on first run)
  let beforeSha = "";
  try {
    beforeSha = run(["git", "rev-parse", "HEAD"], updateDir);
  } catch {
    // No commits yet — first fetch
  }
  if (beforeSha !== "") {
    log(`current: ${beforeSha.slice(0, 8)}`);
  }

  // Fetch from upstream (shallow)
  log("fetching...");
  try {
    run(["git", "fetch", "--depth", "1", upstream], updateDir);
  } catch (err: unknown) {
    console.error("[update] fetch failed:", err);
    process.exit(1);
  }

  // Checkout FETCH_HEAD (detached HEAD)
  try {
    run(["git", "checkout", "FETCH_HEAD"], updateDir);
  } catch (err: unknown) {
    console.error("[update] checkout failed:", err);
    process.exit(1);
  }

  const afterSha = run(["git", "rev-parse", "HEAD"], updateDir);

  if (beforeSha === afterSha) {
    log("already up to date");
    return;
  }

  log(`updated: ${(beforeSha || "(none)").slice(0, 8)} → ${afterSha.slice(0, 8)}`);

  // Build
  log("installing dependencies...");
  pnpm(["install", "--frozen-lockfile"], updateDir);

  log("building...");
  pnpm(["run", "build"], updateDir);

  // Rewrite workspace:* to file: paths for npm compatibility, then install globally
  const cliDir = join(updateDir, "packages", "cli");
  const cliPkgPath = join(cliDir, "package.json");
  const originalPkgJson = readFileSync(cliPkgPath, "utf-8");
  log("installing...");
  try {
    rewriteWorkspaceDeps(cliDir, updateDir);
    run(["npm", "install", "-g", "."], cliDir);
  } finally {
    // Restore original package.json to keep working tree clean
    writeFileSync(cliPkgPath, originalPkgJson, "utf-8");
  }

  log("update complete — restart gateway to apply");
}

export { main as runUpdate };
