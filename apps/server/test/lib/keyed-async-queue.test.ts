import { describe, expect, it } from "vitest";

import { KeyedAsyncQueue } from "../../src/lib/keyed-async-queue";

describe("KeyedAsyncQueue", () => {
  it("serializes tasks for the same key", async () => {
    const queue = new KeyedAsyncQueue();
    const events: string[] = [];

    const first = queue.enqueue("conversation-1", async () => {
      events.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("first:end");
      return "first";
    });

    const second = queue.enqueue("conversation-1", async () => {
      events.push("second:start");
      events.push("second:end");
      return "second";
    });

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("keeps different keys independent and cleans up settled tails", async () => {
    const queue = new KeyedAsyncQueue();
    const events: string[] = [];

    await Promise.all([
      queue.enqueue("conversation-1", async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        events.push("slow");
      }),
      queue.enqueue("conversation-2", async () => {
        events.push("fast");
      })
    ]);

    expect(events).toContain("fast");
    expect(events).toContain("slow");
    expect(queue.getTailMapForTesting().size).toBe(0);
  });

  it("does not poison the queue after a rejection", async () => {
    const queue = new KeyedAsyncQueue();

    await expect(
      queue.enqueue("conversation-1", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    await expect(
      queue.enqueue("conversation-1", async () => "recovered")
    ).resolves.toBe("recovered");
  });
});

