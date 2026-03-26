import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(thisDir, "..", "..", "..");

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

async function main(): Promise<void> {
  // Determine upstream: env var > config file > default git remote (origin)
  const config = loadConfig();
  const upstream = config.upstream;

  try {
    // Check if we're in a git repo
    run(["git", "rev-parse", "--git-dir"], repoRoot);
  } catch {
    console.error("[update] not a git repository — update requires a git clone installation");
    process.exit(1);
  }

  const beforeSha = run(["git", "rev-parse", "HEAD"], repoRoot);
  log(`current: ${beforeSha.slice(0, 8)}`);

  // Determine fetch source: custom upstream or default origin
  const fetchSource = upstream ?? "origin";
  if (upstream !== undefined) {
    log(`upstream: ${upstream}`);
  }

  // Fetch from upstream (without modifying origin remote)
  log("fetching...");
  try {
    run(["git", "fetch", fetchSource], repoRoot);
  } catch (err: unknown) {
    console.error("[update] fetch failed:", err);
    process.exit(1);
  }

  const branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  log(`branch: ${branch}`);

  try {
    run(["git", "pull", fetchSource, branch, "--ff-only"], repoRoot);
  } catch (err: unknown) {
    console.error("[update] pull failed (non-fast-forward?):", err);
    process.exit(1);
  }

  const afterSha = run(["git", "rev-parse", "HEAD"], repoRoot);

  if (beforeSha === afterSha) {
    log("already up to date");
    return;
  }

  log(`updated: ${beforeSha.slice(0, 8)} → ${afterSha.slice(0, 8)}`);

  // Rebuild
  log("installing dependencies...");
  run(["pnpm", "install", "--frozen-lockfile"], repoRoot);

  log("building...");
  run(["pnpm", "run", "build"], repoRoot);

  log("update complete — restart gateway and agent to apply");
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
