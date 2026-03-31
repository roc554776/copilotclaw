import { describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../../src/config.js";

// We test the exported async functions. resolveToken / resolveUsername are internal
// but exercised through the public API. We mock child_process and fs to avoid
// real filesystem / CLI access, and global.fetch for HTTP calls.

// Dynamic import so mocks are in place before the module evaluates.
const { execFileSync } = await vi.hoisted(async () => {
  const execFileSync = vi.fn();
  return { execFileSync };
});
vi.mock("node:child_process", () => ({ execFileSync }));

const { readFileSync } = await vi.hoisted(async () => {
  const readFileSync = vi.fn();
  return { readFileSync };
});
vi.mock("node:fs", () => ({ readFileSync }));

const { fetchPremiumRequestUsage, fetchGitHubModels } = await import("../../src/github-api.js");

describe("fetchPremiumRequestUsage", () => {
  it("returns null when auth is undefined", async () => {
    expect(await fetchPremiumRequestUsage(undefined)).toBeNull();
  });

  it("returns null when token resolution fails", async () => {
    execFileSync.mockImplementation(() => { throw new Error("gh not found"); });
    const auth: AuthConfig = { type: "gh-auth" };
    expect(await fetchPremiumRequestUsage(auth)).toBeNull();
  });

  it("returns null when username resolution fails after token succeeds", async () => {
    // tokenCommand returns a token, but username resolution (gh api /user) fails
    execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes("token") || args.includes("--jq")) {
        // first call (token) succeeds, second call (username) fails
        if (args.includes("--jq")) throw new Error("no user");
        return "ghp_testtoken\n";
      }
      throw new Error("unexpected");
    });
    const auth: AuthConfig = { type: "gh-auth" };
    expect(await fetchPremiumRequestUsage(auth)).toBeNull();
  });

  it("resolves token from tokenEnv for pat type", async () => {
    process.env["TEST_GH_TOKEN_FOR_GITHUB_API"] = "ghp_envtoken";
    const auth: AuthConfig = { type: "pat", user: "testuser", tokenEnv: "TEST_GH_TOKEN_FOR_GITHUB_API" };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        timePeriod: { year: 2026, month: 3 },
        user: "testuser",
        usageItems: [],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchPremiumRequestUsage(auth);
    expect(result).not.toBeNull();
    expect(result!.user).toBe("testuser");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toContain("/users/testuser/settings/billing/premium_request/usage");
    expect(opts.headers.Authorization).toBe("Bearer ghp_envtoken");

    delete process.env["TEST_GH_TOKEN_FOR_GITHUB_API"];
    vi.unstubAllGlobals();
  });

  it("resolves token from tokenFile for pat type", async () => {
    readFileSync.mockReturnValue("ghp_filetoken\n");
    const auth: AuthConfig = { type: "pat", user: "fileuser", tokenFile: "/tmp/token" };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        timePeriod: { year: 2026, month: 3 },
        user: "fileuser",
        usageItems: [],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchPremiumRequestUsage(auth);
    expect(result).not.toBeNull();
    expect(result!.user).toBe("fileuser");

    vi.unstubAllGlobals();
  });

  it("resolves token from tokenCommand", async () => {
    execFileSync.mockImplementation((cmd: string) => {
      if (cmd === "my-token-cmd") return "ghp_cmdtoken\n";
      throw new Error("unexpected");
    });
    const auth: AuthConfig = { type: "pat", user: "cmduser", tokenCommand: "my-token-cmd" };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        timePeriod: { year: 2026, month: 3 },
        user: "cmduser",
        usageItems: [],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchPremiumRequestUsage(auth);
    expect(result).not.toBeNull();

    vi.unstubAllGlobals();
  });

  it("returns null when GitHub API returns non-ok", async () => {
    process.env["TEST_GH_TOKEN_ERR"] = "ghp_token";
    const auth: AuthConfig = { type: "pat", user: "testuser", tokenEnv: "TEST_GH_TOKEN_ERR" };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    expect(await fetchPremiumRequestUsage(auth)).toBeNull();

    delete process.env["TEST_GH_TOKEN_ERR"];
    vi.unstubAllGlobals();
  });

  it("returns null when fetch throws", async () => {
    process.env["TEST_GH_TOKEN_THROW"] = "ghp_token";
    const auth: AuthConfig = { type: "pat", user: "testuser", tokenEnv: "TEST_GH_TOKEN_THROW" };

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    expect(await fetchPremiumRequestUsage(auth)).toBeNull();

    delete process.env["TEST_GH_TOKEN_THROW"];
    vi.unstubAllGlobals();
  });
});

describe("fetchGitHubModels", () => {
  it("returns null when auth is undefined", async () => {
    expect(await fetchGitHubModels(undefined)).toBeNull();
  });

  it("returns null when token resolution fails", async () => {
    execFileSync.mockImplementation(() => { throw new Error("gh not found"); });
    const auth: AuthConfig = { type: "gh-auth" };
    expect(await fetchGitHubModels(auth)).toBeNull();
  });

  it("returns model array on success", async () => {
    process.env["TEST_GH_TOKEN_MODELS"] = "ghp_token";
    const auth: AuthConfig = { type: "pat", tokenEnv: "TEST_GH_TOKEN_MODELS" };
    const mockModels = [{ id: "gpt-4o", name: "GPT-4o", publisher: "OpenAI" }];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockModels,
    }));

    const result = await fetchGitHubModels(auth);
    expect(result).toEqual(mockModels);

    delete process.env["TEST_GH_TOKEN_MODELS"];
    vi.unstubAllGlobals();
  });

  it("returns null when response is not an array", async () => {
    process.env["TEST_GH_TOKEN_NOTARR"] = "ghp_token";
    const auth: AuthConfig = { type: "pat", tokenEnv: "TEST_GH_TOKEN_NOTARR" };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: "unexpected format" }),
    }));

    expect(await fetchGitHubModels(auth)).toBeNull();

    delete process.env["TEST_GH_TOKEN_NOTARR"];
    vi.unstubAllGlobals();
  });

  it("returns null on fetch error", async () => {
    process.env["TEST_GH_TOKEN_FETCHERR"] = "ghp_token";
    const auth: AuthConfig = { type: "pat", tokenEnv: "TEST_GH_TOKEN_FETCHERR" };

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));

    expect(await fetchGitHubModels(auth)).toBeNull();

    delete process.env["TEST_GH_TOKEN_FETCHERR"];
    vi.unstubAllGlobals();
  });
});
