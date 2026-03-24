import { describe, expect, it } from "vitest";

import { reduceAgentEvents } from "../../src/lib/control-plane";

describe("control-plane reducer", () => {
  it("folds live SSE events into runtime, plan, and command state", () => {
    const reduced = reduceAgentEvents([
      {
        type: "run_started",
        runId: "run_1",
        at: "2026-03-24T00:30:00.000Z",
        channel: "agent"
      },
      {
        type: "plan_updated",
        runId: "run_1",
        at: "2026-03-24T00:30:01.000Z",
        channel: "agent",
        steps: [{ id: "inspect", title: "Inspect repo", status: "in_progress" }]
      },
      {
        type: "message_delta",
        runId: "run_1",
        at: "2026-03-24T00:30:02.000Z",
        channel: "agent",
        text: "Streaming"
      },
      {
        type: "command_completed",
        runId: "run_1",
        at: "2026-03-24T00:30:03.000Z",
        channel: "agent",
        execution: {
          id: "cmd_1",
          command: "Get-ChildItem",
          cwd: ".",
          exitCode: 0,
          truncated: false,
          outputPreview: "files",
          durationMs: 11
        }
      }
    ]);

    expect(reduced.runtime.turnState).toBe("running");
    expect(reduced.runtime.draftAssistant).toBe("Streaming");
    expect(reduced.plan).toHaveLength(1);
    expect(reduced.commands).toHaveLength(1);
  });
});
