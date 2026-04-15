import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, ensureConfigFile, getConfigFilePath, getProfileName, getStateDir, loadConfig, saveConfig } from "./config.js";
import { ensureWorkspace, getDataDir, getWorkspaceRoot } from "./workspace.js";

function log(message: string): void {
  console.error(`[setup] ${message}`);
}

// Port candidates: non-round, non-common numbers in the registered range.
// Avoids well-known ports, common dev ports (3000, 8080, etc.), and round numbers.
const PORT_CANDIDATES = [
  19741, // default
  19743, 19747, 19753, 19759,
  21473, 21479, 21487, 21491,
  23147, 23153, 23159, 23167,
  24713, 24719, 24733, 24749,
  27143, 27149, 27163, 27179,
];

/** Check if a port is available by attempting to bind it. */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => { resolve(false); });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => { resolve(true); });
    });
  });
}

/** Find the first available port from the candidate list. */
export async function findAvailablePort(candidates: readonly number[] = PORT_CANDIDATES): Promise<number | undefined> {
  for (const port of candidates) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  return undefined;
}

/** Scan all profile state directories and collect their configured ports. */
function collectOtherProfilePorts(currentProfile: string | undefined): number[] {
  const home = homedir();
  const ports: number[] = [];
  try {
    const entries = readdirSync(home);
    for (const entry of entries) {
      // Match .copilotclaw (default) and .copilotclaw-{{profile}} (named)
      if (!entry.startsWith(".copilotclaw")) continue;
      const isDefault = entry === ".copilotclaw";
      const isNamed = entry.startsWith(".copilotclaw-") && entry.length > ".copilotclaw-".length;
      if (!isDefault && !isNamed) continue;

      // Determine the profile name for this entry
      const entryProfile = isDefault ? undefined : entry.slice(".copilotclaw-".length);
      // Skip the current profile
      if (entryProfile === currentProfile) continue;
      if (entryProfile === undefined && currentProfile === undefined) continue;

      const configPath = join(home, entry, "config.json");
      try {
        const raw = readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw) as { port?: number };
        if (typeof config.port === "number" && config.port > 0) {
          ports.push(config.port);
        }
      } catch {
        // Config missing or malformed — skip
      }
    }
  } catch {
    // Home directory unreadable — unlikely but non-fatal
  }
  return ports;
}

async function main(): Promise<void> {
  const root = getWorkspaceRoot(getProfileName());
  const alreadyExists = existsSync(getDataDir(getProfileName()));

  ensureWorkspace(getProfileName());
  ensureConfigFile(getProfileName());

  if (alreadyExists) {
    log(`workspace already exists at ${root}`);
  } else {
    log(`workspace created at ${root}`);
  }

  log(`config: ${getConfigFilePath(getProfileName())}`);

  // Port selection: if config already has a port, skip. Otherwise find an available port.
  // Exclude ports already claimed by other profiles to prevent collisions.
  const existingConfig = loadConfig(getProfileName());
  if (existingConfig.port === undefined) {
    const profile = getProfileName();
    const otherPorts = collectOtherProfilePorts(profile);
    const excludePorts = new Set(otherPorts);
    if (profile !== undefined) {
      // Named profiles must never use DEFAULT_PORT (likely used by default profile)
      excludePorts.add(DEFAULT_PORT);
    }
    const candidates = PORT_CANDIDATES.filter((p) => !excludePorts.has(p));

    if (profile === undefined) {
      // Default profile: try DEFAULT_PORT first if not claimed by another profile
      if (!excludePorts.has(DEFAULT_PORT) && await isPortAvailable(DEFAULT_PORT)) {
        log(`using default port ${DEFAULT_PORT}`);
      } else {
        log(`default port ${DEFAULT_PORT} is unavailable, searching for available port...`);
        const available = await findAvailablePort(candidates);
        if (available !== undefined) {
          saveConfig({ ...existingConfig, port: available }, profile);
          log(`port ${available} selected and saved to config`);
        } else {
          log(`ERROR: no available port found — set port manually in config`);
          process.exit(1);
        }
      }
    } else {
      log(`searching for available port for profile "${profile}"...`);
      const available = await findAvailablePort(candidates);
      if (available !== undefined) {
        saveConfig({ ...existingConfig, port: available }, profile);
        log(`port ${available} selected and saved to config`);
      } else {
        log(`ERROR: no available port found — set port manually in config`);
        process.exit(1);
      }
    }
  } else {
    log(`port ${existingConfig.port} configured`);
  }

  // Migrate workspace files from state dir root to workspace/ subdirectory (v0.26 → v0.27 transition)
  migrateWorkspaceFiles(getStateDir(getProfileName()), root);

  // Ensure workspace is fully set up: dir, git init, bootstrap files, initial commit
  ensureWorkspaceReady(root);

  log("setup complete");
}

/** Migrate workspace files from state dir root to workspace/ subdirectory.
 *  Handles the v0.26 → v0.27 transition where getWorkspaceRoot() changed from
 *  returning stateDir to stateDir/workspace/. Files at the old location are
 *  moved to the new location if they don't already exist there. */
export function migrateWorkspaceFiles(stateDir: string, workspaceRoot: string): void {
  // Only migrate if workspace is a subdirectory of stateDir (normal case)
  if (stateDir === workspaceRoot) return;

  const filesToMigrate = ["SOUL.md", "AGENTS.md", "USER.md", "TOOLS.md", "MEMORY.md"];
  const dirsToMigrate = ["memory"];

  for (const file of filesToMigrate) {
    const oldPath = join(stateDir, file);
    const newPath = join(workspaceRoot, file);
    if (existsSync(oldPath) && !existsSync(newPath)) {
      mkdirSync(workspaceRoot, { recursive: true });
      renameSync(oldPath, newPath);
      log(`migrated ${file} to workspace/`);
    }
  }

  for (const dir of dirsToMigrate) {
    const oldPath = join(stateDir, dir);
    const newPath = join(workspaceRoot, dir);
    if (existsSync(oldPath) && statSync(oldPath).isDirectory() && !existsSync(newPath)) {
      mkdirSync(workspaceRoot, { recursive: true });
      renameSync(oldPath, newPath);
      log(`migrated ${dir}/ to workspace/`);
    }
  }

  // Migrate .git directory if it exists at state dir root
  const oldGit = join(stateDir, ".git");
  const newGit = join(workspaceRoot, ".git");
  if (existsSync(oldGit) && statSync(oldGit).isDirectory() && !existsSync(newGit)) {
    mkdirSync(workspaceRoot, { recursive: true });
    renameSync(oldGit, newGit);
    log("migrated .git/ to workspace/");
  }
}

/** Write default workspace bootstrap files if they don't already exist. */
export function seedWorkspaceBootstrapFiles(workspaceRoot: string): void {
  const files: Record<string, string> = {
    "SOUL.md": SOUL_TEMPLATE,
    "AGENTS.md": AGENTS_TEMPLATE,
    "USER.md": USER_TEMPLATE,
    "TOOLS.md": TOOLS_TEMPLATE,
  };
  // Ensure memory directory exists with .gitkeep
  const memoryDir = join(workspaceRoot, "memory");
  if (!existsSync(memoryDir) || !statSync(memoryDir).isDirectory()) {
    mkdirSync(memoryDir, { recursive: true });
  }
  const gitkeep = join(memoryDir, ".gitkeep");
  if (!existsSync(gitkeep)) {
    writeFileSync(gitkeep, "", "utf-8");
  }
  if (!existsSync(join(workspaceRoot, "MEMORY.md"))) {
    writeFileSync(join(workspaceRoot, "MEMORY.md"), MEMORY_TEMPLATE, "utf-8");
    log("created MEMORY.md");
  }

  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(workspaceRoot, filename);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content, "utf-8");
      log(`created ${filename}`);
    }
  }
}

/** Initialize git repo in workspace if git is available and .git doesn't exist. */
function initWorkspaceGit(workspaceRoot: string): void {
  if (existsSync(join(workspaceRoot, ".git"))) return;
  if (!isGitAvailable()) return;
  const init = spawnSync("git", ["init"], { cwd: workspaceRoot, encoding: "utf-8", stdio: "pipe" });
  if (init.status === 0) {
    log("initialized git repo in workspace");
  } else {
    log(`WARNING: git init failed (exit ${init.status ?? "null"}) — workspace will not be version-controlled`);
  }
}

/** Check if git CLI is available. */
export function isGitAvailable(): boolean {
  const check = spawnSync("git", ["--version"], { encoding: "utf-8", stdio: "pipe" });
  return check.status === 0;
}

/** Ensure workspace is fully set up: directory, git init, bootstrap files, initial commit.
 *  Safe to call multiple times — only creates/commits what is missing. */
export function ensureWorkspaceReady(workspaceRoot: string): void {
  mkdirSync(workspaceRoot, { recursive: true });
  initWorkspaceGit(workspaceRoot);
  seedWorkspaceBootstrapFiles(workspaceRoot);
  commitInitialWorkspaceFiles(workspaceRoot);
}

/** Git add + commit initial workspace files if the repo has no commits yet. */
function commitInitialWorkspaceFiles(workspaceRoot: string): void {
  if (!existsSync(join(workspaceRoot, ".git"))) return;

  // Check if there are any commits already
  const logCheck = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot, encoding: "utf-8", stdio: "pipe" });
  if (logCheck.status === 0) return; // commits exist — skip

  // Stage all workspace files
  const add = spawnSync("git", ["add", "-A"], { cwd: workspaceRoot, encoding: "utf-8", stdio: "pipe" });
  if (add.status !== 0) return;

  // Check if there's anything staged
  const diffIndex = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: workspaceRoot, encoding: "utf-8", stdio: "pipe" });
  if (diffIndex.status === 0) return; // nothing staged

  const commit = spawnSync("git", ["commit", "-m", "Initial workspace setup"], { cwd: workspaceRoot, encoding: "utf-8", stdio: "pipe" });
  if (commit.status === 0) {
    log("committed initial workspace files");
  }
}

/** Check workspace health. Returns list of issues found. */
export function checkWorkspaceHealth(workspaceRoot: string): string[] {
  const issues: string[] = [];
  if (!existsSync(workspaceRoot)) {
    issues.push("workspace directory missing");
    return issues; // can't check further
  }

  const requiredFiles = ["SOUL.md", "USER.md", "TOOLS.md", "MEMORY.md"];
  for (const file of requiredFiles) {
    if (!existsSync(join(workspaceRoot, file))) {
      issues.push(`missing ${file}`);
    }
  }
  if (!existsSync(join(workspaceRoot, "memory"))) {
    issues.push("missing memory/ directory");
  }
  if (!existsSync(join(workspaceRoot, ".git")) && isGitAvailable()) {
    issues.push("workspace not git-initialized");
  }
  return issues;
}

const SOUL_TEMPLATE = `# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the filler words — just help.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the context. Then ask if you're stuck.

**Earn trust through competence.** Be careful with external actions. Be bold with internal ones (reading, organizing, learning).

## Boundaries

- Private things stay private
- When in doubt, ask before acting externally
- Never send half-baked replies

## Vibe

Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters.

## Continuity

Each session, you wake up fresh. The files in this workspace are your memory. Read them. Update them. They're how you persist.

If you change this file, tell the user — it's your soul, and they should know.

---

_This file is yours to evolve. As you learn who you are, update it._
`;

const AGENTS_TEMPLATE = `# AGENTS.md - Your Workspace

This folder is home. Treat it that way.

## Session Startup

Before doing anything else:

- Read SOUL.md — this is who you are
- Read USER.md — this is who you're helping
- Read memory/ (today + yesterday) for recent context
- Read MEMORY.md for long-term context

Don't ask permission. Just do it.

## Memory

You wake up fresh each session. These files are your continuity:

- **Daily notes:** memory/YYYY-MM-DD.md — raw logs of what happened
- **Long-term:** MEMORY.md — your curated memories

Capture what matters. Decisions, context, things to remember.

### Write It Down

Memory is limited — if you want to remember something, WRITE IT TO A FILE. "Mental notes" don't survive session restarts. Files do.

## Safety

- Don't exfiltrate private data
- Don't run destructive commands without asking
- When in doubt, ask

## Proactive Work

Things you can do without asking:

- Read and organize memory files
- Update documentation
- Commit and push your own changes
- Review and update MEMORY.md

## Make It Yours

This is a starting point. Add your own conventions, style, and rules as you figure out what works.
`;

const USER_TEMPLATE = `# USER.md - About the User

_Fill this in with information about yourself so your agent knows who you're helping._

## Name

(Your name)

## Preferences

(Your working style, communication preferences, etc.)

## Context

(What you're working on, your role, etc.)
`;

const TOOLS_TEMPLATE = `# TOOLS.md - Tool Notes

_Keep local notes about tools and configurations here._

## Available Tools

Your copilotclaw agent has access to standard Copilot built-in tools (file operations, shell, search, etc.) plus:

- copilotclaw_send_message — Send a message to the chat channel
- copilotclaw_wait — Wait for user input, subagent completion, or other events
- copilotclaw_list_messages — List recent messages in the channel

## Local Notes

(Add your own notes about SSH hosts, API keys location, project-specific tools, etc.)
`;

const MEMORY_TEMPLATE = `# MEMORY.md - Long-Term Memory

_Your curated long-term memory. Write significant events, decisions, lessons learned._

_Over time, review daily files in memory/ and distill what's worth keeping here._
`;

const isDirectExecution = process.argv[1]?.endsWith("setup.js") === true;
if (isDirectExecution) {
  main().catch((err: unknown) => {
    console.error("Error:", err);
    process.exit(1);
  });
}
