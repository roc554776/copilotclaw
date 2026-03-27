import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DEFAULT_PORT, ensureConfigFile, getConfigFilePath, getProfileName, loadConfig, saveConfig } from "./config.js";
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
    server.listen(port, () => {
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

  // Port selection: if config already has a port, skip. Otherwise check default.
  const existingConfig = loadConfig(getProfileName());
  if (existingConfig.port === undefined) {
    const defaultAvailable = await isPortAvailable(DEFAULT_PORT);
    if (!defaultAvailable) {
      log(`default port ${DEFAULT_PORT} is in use, searching for available port...`);
      const available = await findAvailablePort(PORT_CANDIDATES.filter((p) => p !== DEFAULT_PORT));
      if (available !== undefined) {
        saveConfig({ ...existingConfig, port: available }, getProfileName());
        log(`port ${available} selected and saved to config`);
      } else {
        log(`ERROR: no available port found — set port manually in config`);
        process.exit(1);
      }
    }
  } else {
    log(`port ${existingConfig.port} configured`);
  }

  // Bootstrap workspace files (SOUL.md, AGENTS.md, USER.md, TOOLS.md) — write only if missing
  seedWorkspaceBootstrapFiles(root);

  // Initialize git repo in workspace (if git available and no .git yet)
  initWorkspaceGit(root);

  log("setup complete");
}

/** Write default workspace bootstrap files if they don't already exist. */
export function seedWorkspaceBootstrapFiles(workspaceRoot: string): void {
  const files: Record<string, string> = {
    "SOUL.md": SOUL_TEMPLATE,
    "AGENTS.md": AGENTS_TEMPLATE,
    "USER.md": USER_TEMPLATE,
    "TOOLS.md": TOOLS_TEMPLATE,
  };
  // Ensure memory directory exists
  const memoryDir = join(workspaceRoot, "memory");
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
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
  const check = spawnSync("git", ["--version"], { encoding: "utf-8", stdio: "pipe" });
  if (check.status !== 0) return; // git not available
  const init = spawnSync("git", ["init"], { cwd: workspaceRoot, encoding: "utf-8", stdio: "pipe" });
  if (init.status === 0) {
    log("initialized git repo in workspace");
  }
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
- copilotclaw_receive_input — Wait for user input from the chat channel
- copilotclaw_list_messages — List recent messages in the channel

## Local Notes

(Add your own notes about SSH hosts, API keys location, project-specific tools, etc.)
`;

const MEMORY_TEMPLATE = `# MEMORY.md - Long-Term Memory

_Your curated long-term memory. Write significant events, decisions, lessons learned._

_Over time, review daily files in memory/ and distill what's worth keeping here._
`;

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
