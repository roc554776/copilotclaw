import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageAvatar } from "../components/MessageAvatar";

afterEach(() => {
  cleanup();
});

describe("MessageAvatar", () => {
  it("renders user avatar with testid avatar-user", () => {
    render(<MessageAvatar sender="user" />);
    expect(screen.getByTestId("avatar-user")).toBeDefined();
  });

  it("renders cron avatar with testid avatar-cron", () => {
    render(<MessageAvatar sender="cron" />);
    expect(screen.getByTestId("avatar-cron")).toBeDefined();
  });

  it("renders system avatar with testid avatar-system", () => {
    render(<MessageAvatar sender="system" />);
    expect(screen.getByTestId("avatar-system")).toBeDefined();
  });

  it("renders agent avatar with testid avatar-agent", () => {
    render(<MessageAvatar sender="agent" />);
    expect(screen.getByTestId("avatar-agent")).toBeDefined();
  });

  it("agent avatar shows initials from agentDisplayName", () => {
    render(
      <MessageAvatar
        sender="agent"
        senderMeta={{ agentId: "channel-operator", agentDisplayName: "Channel Operator", agentRole: "channel-operator" }}
      />,
    );
    const avatar = screen.getByTestId("avatar-agent");
    expect(avatar.textContent).toMatch(/CO/i);
  });

  it("agent avatar is clickable when onAgentClick is provided", () => {
    const onAgentClick = vi.fn();
    const meta = { agentId: "worker", agentDisplayName: "Worker", agentRole: "subagent" as const };
    render(
      <MessageAvatar
        sender="agent"
        senderMeta={meta}
        onAgentClick={onAgentClick}
      />,
    );
    const avatar = screen.getByTestId("avatar-agent");
    expect(avatar.getAttribute("role")).toBe("button");
    fireEvent.click(avatar);
    expect(onAgentClick).toHaveBeenCalledWith(meta);
  });

  it("agent avatar is not clickable when onAgentClick is not provided", () => {
    render(
      <MessageAvatar
        sender="agent"
        senderMeta={{ agentId: "channel-operator", agentDisplayName: "Channel Operator", agentRole: "channel-operator" }}
      />,
    );
    const avatar = screen.getByTestId("avatar-agent");
    expect(avatar.getAttribute("role")).toBeNull();
  });

  it("user avatar is never clickable", () => {
    const onAgentClick = vi.fn();
    render(<MessageAvatar sender="user" onAgentClick={onAgentClick} />);
    const avatar = screen.getByTestId("avatar-user");
    fireEvent.click(avatar);
    expect(onAgentClick).not.toHaveBeenCalled();
  });

  it("agent avatar keyboard Enter triggers onAgentClick", () => {
    const onAgentClick = vi.fn();
    const meta = { agentId: "channel-operator", agentDisplayName: "Channel Operator", agentRole: "channel-operator" as const };
    render(
      <MessageAvatar
        sender="agent"
        senderMeta={meta}
        onAgentClick={onAgentClick}
      />,
    );
    const avatar = screen.getByTestId("avatar-agent");
    fireEvent.keyDown(avatar, { key: "Enter" });
    expect(onAgentClick).toHaveBeenCalledWith(meta);
  });
});
