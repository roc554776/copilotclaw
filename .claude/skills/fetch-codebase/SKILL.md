---
name: fetch-codebase
description: Use when you need to deeply understand the usage, behavior, or internal implementation of an external library, tool, or framework by reading its source code. Trigger whenever you need to deep-dive into an external codebase, investigate how an external dependency works beyond what documentation provides, or the human asks you to look at another repository's code. Also trigger when you find yourself speculating about how an external system works — fetch the code and read it instead.
---

# Fetch External Codebase

Fetch and investigate source code from external repositories to deeply understand their usage, behavior, and internal implementation.

## When to use this

When you need to understand how an external library, framework, or tool actually works — not just its public API, but its internals. Reading source code is often more reliable than documentation, especially for edge cases, undocumented behavior, or understanding design decisions.

## Fetching external code

Run the fetch script from the repository root:

```bash
python3 .claude/skills/fetch-codebase/scripts/fetch-codebase.py --url <git-url> [--path <owner/repo>] [--commitish <branch-or-tag>]
```

For GitHub URLs, `--path` and `--commitish` are auto-detected (default branch via `gh` CLI). For non-GitHub URLs, both are required.

External codebases are stored at `tmp/ref/{{owner}}/{{repo}}/`. An `index.json` in `tmp/ref/` tracks what has been fetched.

If the repository has already been fetched (check `tmp/ref/index.json` or the directory), you can skip fetching and read the code directly.

## Reading the fetched code

The `tmp/` directory is gitignored. When searching fetched code, keep this in mind:

| Tool | Notes |
|------|-------|
| **Grep** | Works normally — searches all files regardless of gitignore |
| **Glob** | Works normally |
| **Read** | Works normally |

Use these tools to navigate the fetched codebase just as you would any local code. Start with a broad search to orient yourself, then drill into specific files.

## Important notes

- External codebases are references — do not modify them
- Fetched code uses shallow clone (depth 1) to minimize disk usage
- Re-running the script on an already-fetched repo updates it to the latest commitish
