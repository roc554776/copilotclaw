#!/usr/bin/env python3
"""
Fetch an external repository into tmp/ref/{{owner}}/{{repo}}/ for deep-dive investigation.

Uses shallow clone (depth 1) to minimize disk and network usage.
For GitHub URLs, owner/repo and default branch are auto-detected.

Usage:
    python3 scripts/fetch-codebase.py --url <git-url> [--path <owner/repo>] [--commitish <branch-or-tag>]

Examples:
    # GitHub URL (auto-detects owner/repo and default branch)
    python3 scripts/fetch-codebase.py --url https://github.com/github/copilot-sdk.git

    # Explicit commitish
    python3 scripts/fetch-codebase.py --url https://github.com/github/copilot-sdk.git --commitish v0.2.0

    # Non-GitHub URL (--path and --commitish required)
    python3 scripts/fetch-codebase.py --url https://gitlab.com/some/repo.git --path some/repo --commitish main
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def parse_github_url(url: str) -> tuple[str, str] | None:
    """Extract (owner, repo) from a GitHub URL, or None if not a GitHub URL."""
    if "github.com" not in url:
        return None
    m = re.search(r"github\.com[/:]([^/]+)/([^/.]+)", url)
    if m:
        return m.group(1), m.group(2)
    return None


def get_default_branch(owner: str, repo: str) -> str:
    """Use the gh CLI to look up the default branch of a GitHub repo."""
    result = subprocess.run(
        ["gh", "repo", "view", f"{owner}/{repo}", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def get_repo_root() -> Path:
    """Return the repository root by navigating up from this script's location.

    Layout: {{repo_root}}/.claude/skills/fetch-codebase/scripts/fetch-codebase.py
    """
    return Path(__file__).resolve().parent.parent.parent.parent.parent


def run_git(target_dir: str, *args: str) -> None:
    subprocess.run(["git", "-C", target_dir, *args], check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch an external repository for deep-dive investigation.")
    parser.add_argument("-u", "--url", required=True, help="Git clone URL")
    parser.add_argument("-p", "--path", help="Relative path under tmp/ref/ (e.g. owner/repo). Auto-detected for GitHub URLs.")
    parser.add_argument("-c", "--commitish", help="Branch, tag, or commit to fetch. Auto-detected for GitHub URLs.")
    args = parser.parse_args()

    git_url: str = args.url
    github_info = parse_github_url(git_url)

    rel_path: str
    if args.path:
        rel_path = args.path
    elif github_info:
        rel_path = f"{github_info[0]}/{github_info[1]}"
        print(f"GitHub URL detected. Using path: {rel_path}")
    else:
        print("Error: --path is required for non-GitHub URLs", file=sys.stderr)
        sys.exit(1)

    commitish: str
    if args.commitish:
        commitish = args.commitish
    elif github_info:
        print(f"Fetching default branch for {github_info[0]}/{github_info[1]}...")
        commitish = get_default_branch(*github_info)
        print(f"Using default branch: {commitish}")
    else:
        print("Error: --commitish is required for non-GitHub URLs", file=sys.stderr)
        sys.exit(1)

    repo_root = get_repo_root()
    ref_dir = repo_root / "tmp" / "ref"
    target_dir = ref_dir / rel_path
    resolved_target = target_dir.resolve()
    resolved_ref = ref_dir.resolve()
    if resolved_target == resolved_ref or not resolved_target.is_relative_to(resolved_ref):
        print(
            f"Error: --path must resolve to a subdirectory under {ref_dir} (got {target_dir})",
            file=sys.stderr,
        )
        sys.exit(1)
    index_path = ref_dir / "index.json"

    print(f"Target directory: {target_dir}")
    print(f"Commitish: {commitish}")

    index_data: dict = {}
    if index_path.exists():
        try:
            index_data = json.loads(index_path.read_text())
        except (json.JSONDecodeError, OSError):
            print("Warning: Could not parse index.json, starting fresh")
            index_data = {}

    target_str = str(target_dir)

    print(f"Setting up {target_dir} (fresh clone)")
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    run_git(target_str, "init")
    run_git(target_str, "remote", "add", "origin", git_url)

    print(f"Fetching {commitish} from origin")
    run_git(target_str, "fetch", "--depth", "1", "origin", commitish)
    run_git(target_str, "checkout", "--force", "FETCH_HEAD")

    index_data[rel_path] = {
        "url": git_url,
        "relativePath": rel_path,
        "commitish": commitish,
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
    }
    ref_dir.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(index_data, indent=2) + "\n")

    print(f"Repository fetched successfully: {rel_path}")
    print(f"index.json updated")
    print(f"Code is available at: {target_dir}")


if __name__ == "__main__":
    main()
