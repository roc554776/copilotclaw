import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileModal } from "../components/ProfileModal";

afterEach(() => {
  cleanup();
});

function renderModal(overrides?: Partial<{ agentId: string; agentDisplayName: string; agentRole: "channel-operator" | "subagent" | "worker" | "unknown"; onClose: () => void }>) {
  const defaults = {
    agentId: "channel-operator",
    agentDisplayName: "Channel Operator",
    agentRole: "channel-operator" as const,
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<ProfileModal {...defaults} />), onClose: defaults.onClose };
}

describe("ProfileModal", () => {
  it("renders display name", () => {
    renderModal({ agentDisplayName: "My Agent" });
    expect(screen.getByTestId("profile-modal-display-name").textContent).toBe("My Agent");
  });

  it("renders role badge for channel-operator", () => {
    renderModal({ agentRole: "channel-operator" });
    const badge = screen.getByTestId("profile-modal-role-badge");
    expect(badge.textContent?.toLowerCase()).toContain("channel");
  });

  it("renders role badge for subagent", () => {
    renderModal({ agentRole: "subagent" });
    const badge = screen.getByTestId("profile-modal-role-badge");
    expect(badge.textContent?.toLowerCase()).toContain("subagent");
  });

  it("Info tab is shown by default", () => {
    renderModal();
    expect(screen.getByTestId("profile-modal-info-tab")).toBeDefined();
  });

  it("Info tab shows agentId and role", () => {
    renderModal({ agentId: "my-agent-id", agentRole: "channel-operator" });
    expect(screen.getByTestId("profile-modal-agent-id").textContent).toBe("my-agent-id");
    expect(screen.getByTestId("profile-modal-role-text").textContent).toContain("Channel Operator");
  });

  it("switching to Intent tab shows placeholder", async () => {
    const user = userEvent.setup();
    renderModal();
    const intentTab = screen.getByTestId("profile-modal-tab-intent");
    await user.click(intentTab);
    expect(screen.getByTestId("profile-modal-intent-tab")).toBeDefined();
    expect(screen.getByTestId("profile-modal-intent-placeholder").textContent).toContain("実装予定");
  });

  it("switching back to Info tab works", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByTestId("profile-modal-tab-intent"));
    expect(screen.queryByTestId("profile-modal-info-tab")).toBeNull();
    await user.click(screen.getByTestId("profile-modal-tab-info"));
    expect(screen.getByTestId("profile-modal-info-tab")).toBeDefined();
  });

  it("close button triggers onClose", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await user.click(screen.getByTestId("profile-modal-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape key triggers onClose", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("backdrop click triggers onClose", () => {
    const { onClose } = renderModal();
    const backdrop = screen.getByTestId("profile-modal-backdrop");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking inside modal does not close it", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    const modal = screen.getByTestId("profile-modal");
    await user.click(modal);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("header avatar color changes when agentId changes (uses colorFromString, not hardcoded)", () => {
    const { unmount } = render(
      <ProfileModal agentId="agent-alpha" agentDisplayName="Alpha" agentRole="channel-operator" onClose={vi.fn()} />,
    );
    const avatarA = screen.getByTestId("avatar-agent");
    const colorA = (avatarA as HTMLElement).style.background;
    unmount();

    render(
      <ProfileModal agentId="agent-beta-different" agentDisplayName="Beta" agentRole="channel-operator" onClose={vi.fn()} />,
    );
    const avatarB = screen.getByTestId("avatar-agent");
    const colorB = (avatarB as HTMLElement).style.background;

    // Two distinct agentIds must produce distinct colors
    expect(colorA).not.toBe(colorB);
    // Neither color should be the old hardcoded #238636
    expect(colorA).not.toBe("rgb(35, 134, 54)");
    expect(colorB).not.toBe("rgb(35, 134, 54)");
  });

  it("header avatar renders via MessageAvatar (data-testid avatar-agent present)", () => {
    renderModal({ agentId: "my-agent", agentDisplayName: "My Agent", agentRole: "channel-operator" });
    expect(screen.getByTestId("avatar-agent")).toBeDefined();
  });
});
