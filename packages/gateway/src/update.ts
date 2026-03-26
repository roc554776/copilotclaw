import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { getUpdateDir } from "./workspace.js";

const DEFAULT_UPSTREAM = "https://github.com/roc554776/copilotclaw.git";

function log(message: string): void {
  console.error(`[update] ${message}`);
}

/** Extract .tgz filename from npm pack output. */
export function parseTgzFilename(packOutput: string): string | undefined {
  return packOutput.split("\n").filter((l) => l.trim().endsWith(".tgz")).pop()?.trim() || undefined;
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
  run(["pnpm", "install", "--frozen-lockfile"], updateDir);

  log("building...");
  run(["pnpm", "run", "build"], updateDir);

  // Pack CLI package and reinstall
  const cliDir = join(updateDir, "packages", "cli");
  log("packing...");
  const packOutput = run(["npm", "pack"], cliDir);
  const tgzFile = parseTgzFilename(packOutput);
  if (tgzFile === undefined) {
    throw new Error("npm pack produced no .tgz file");
  }
  const tgzPath = join(cliDir, tgzFile);

  log("installing...");
  try {
    run(["npm", "install", "-g", tgzPath], updateDir);
  } finally {
    // Clean up tgz
    try { unlinkSync(tgzPath); } catch { /* ignore */ }
  }

  log("update complete — restart gateway to apply");
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
