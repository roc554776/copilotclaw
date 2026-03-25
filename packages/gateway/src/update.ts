import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(thisDir, "..", "..", "..");

function log(message: string): void {
  console.error(`[update] ${message}`);
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

async function main(): Promise<void> {
  // Determine upstream: use COPILOTCLAW_UPSTREAM env or default git remote
  const upstream = process.env["COPILOTCLAW_UPSTREAM"];

  try {
    // Check if we're in a git repo
    run("git rev-parse --git-dir", repoRoot);
  } catch {
    console.error("[update] not a git repository — update requires a git clone installation");
    process.exit(1);
  }

  const beforeSha = run("git rev-parse HEAD", repoRoot);
  log(`current: ${beforeSha.slice(0, 8)}`);

  // If custom upstream is set (e.g. file:///path/to/repo), configure it
  if (upstream !== undefined) {
    log(`upstream: ${upstream}`);
    try {
      run(`git remote set-url origin ${upstream}`, repoRoot);
    } catch {
      log("failed to set upstream URL");
      process.exit(1);
    }
  }

  // Fetch and pull
  log("fetching...");
  try {
    run("git fetch origin", repoRoot);
  } catch (err: unknown) {
    console.error("[update] fetch failed:", err);
    process.exit(1);
  }

  const branch = run("git rev-parse --abbrev-ref HEAD", repoRoot);
  log(`branch: ${branch}`);

  try {
    run(`git pull origin ${branch} --ff-only`, repoRoot);
  } catch (err: unknown) {
    console.error("[update] pull failed (non-fast-forward?):", err);
    process.exit(1);
  }

  const afterSha = run("git rev-parse HEAD", repoRoot);

  if (beforeSha === afterSha) {
    log("already up to date");
    return;
  }

  log(`updated: ${beforeSha.slice(0, 8)} → ${afterSha.slice(0, 8)}`);

  // Rebuild
  log("installing dependencies...");
  run("pnpm install --frozen-lockfile", repoRoot);

  log("building...");
  run("pnpm run build", repoRoot);

  log("update complete — restart gateway and agent to apply");
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
