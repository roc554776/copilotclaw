import { describe, expect, it, vi } from "vitest";
import { broadcastChannelListChange } from "../../src/daemon.js";
import { Store } from "../../src/store.js";

describe("broadcastChannelListChange", () => {
  it("calls broadcastGlobal with channel_list_change and full channel list", () => {
    const store = new Store();
    const ch1 = store.createChannel();
    const ch2 = store.createChannel();
    // Archive one channel to confirm includeArchived: true is used
    store.archiveChannel(ch2.id);

    const broadcastGlobal = vi.fn();
    const mockBroadcaster = { broadcastGlobal };

    broadcastChannelListChange(store, mockBroadcaster);

    expect(broadcastGlobal).toHaveBeenCalledTimes(1);
    const callArg = broadcastGlobal.mock.calls[0]![0] as { type: string; channels: Array<{ id: string }> };
    expect(callArg.type).toBe("channel_list_change");
    expect(callArg.channels.some((c) => c.id === ch1.id)).toBe(true);
    // Archived channel should also be included (full list)
    expect(callArg.channels.some((c) => c.id === ch2.id)).toBe(true);
  });

  it("swallows exceptions thrown by store.listChannels without propagating", () => {
    const store = new Store();
    vi.spyOn(store, "listChannels").mockImplementation(() => {
      throw new Error("DB failure");
    });

    const broadcastGlobal = vi.fn();
    const mockBroadcaster = { broadcastGlobal };

    // Must not throw
    expect(() => broadcastChannelListChange(store, mockBroadcaster)).not.toThrow();
    // broadcastGlobal should NOT have been called
    expect(broadcastGlobal).not.toHaveBeenCalled();
  });
});
