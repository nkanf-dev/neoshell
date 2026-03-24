import { describe, expect, it } from "vitest";

import type { AgentDecision } from "@neoshell/shared";

import { runAgentLoop } from "../../src/runtime/agent-loop";

describe("runAgentLoop", () => {
  it("emits plan, command, and final assistant events", async () => {
    const decisions: AgentDecision[] = [
      {
        reasoning: "Need repository status first",
        plan: [
          { id: "status", title: "Inspect repository state", status: "in_progress" },
          { id: "answer", title: "Summarize findings", status: "pending" }
        ],
        action: {
          type: "run_command",
          command: "git status --short --branch",
          cwd: "."
        }
      },
      {
        reasoning: "Enough context collected",
        plan: [
          { id: "status", title: "Inspect repository state", status: "completed" },
          { id: "answer", title: "Summarize findings", status: "completed" }
        ],
        action: {
          type: "final_answer",
          message: "Repository is clean."
        }
      }
    ];

    const events = await runAgentLoop({
      conversationId: "conv_1",
      userMessage: "Check the repository status.",
      maxIterations: 4,
      provider: {
        async decide() {
          const next = decisions.shift();
          if (!next) {
            throw new Error("no decision left");
          }
          return next;
        }
      },
      shell: {
        async run(command) {
          expect(command).toBe("git status --short --branch");
          return {
            command,
            cwd: ".",
            exitCode: 0,
            timedOut: false,
            outputPreview: "## main",
            truncated: false,
            durationMs: 15
          };
        }
      }
    });

    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "plan_updated",
      "thinking",
      "command_started",
      "command_completed",
      "plan_updated",
      "thinking",
      "assistant_message",
      "run_completed"
    ]);
  });

  it("feeds a failed command back into the next decision instead of failing the run", async () => {
    const events = await runAgentLoop({
      conversationId: "conv_fail",
      userMessage: "Check a missing file and explain the result.",
      conversationMessages: [
        {
          id: "msg_1",
          conversationId: "conv_fail",
          role: "user",
          content: "Start from the previous command failure.",
          createdAt: "2026-03-24T00:00:00.000Z"
        }
      ],
      provider: {
        async decide(params) {
          if (params.iteration === 0) {
            expect(params.conversationMessages).toHaveLength(1);
            expect(params.recentExecutions).toHaveLength(0);
            return {
              reasoning: "Check whether the file exists.",
              plan: [{ id: "check", title: "Check the missing file", status: "in_progress" }],
              action: {
                type: "run_command",
                command: "Get-Item missing.txt",
                cwd: "."
              }
            };
          }

          expect(params.lastObservation).toContain("Exit code: 1");
          expect(params.lastObservation).toContain("Timed out: no");
          expect(params.recentExecutions).toHaveLength(1);
          expect(params.recentExecutions[0]?.exitCode).toBe(1);
          expect(params.recentExecutions[0]?.outputPreview).toContain("Cannot find path");
          expect(params.consecutiveCommandFailures).toBe(1);

          return {
            reasoning: "The command failed, so summarize the blocker.",
            plan: [{ id: "check", title: "Check the missing file", status: "blocked" }],
            action: {
              type: "final_answer",
              message: "The file does not exist."
            }
          };
        }
      },
      shell: {
        async run(command) {
          return {
            command,
            cwd: ".",
            exitCode: 1,
            timedOut: false,
            outputPreview: "Cannot find path 'missing.txt' because it does not exist.",
            truncated: false,
            durationMs: 8
          };
        }
      }
    });

    expect(events.some((event) => event.type === "run_failed")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "command_completed" &&
          event.execution.exitCode === 1 &&
          event.execution.timedOut === false
      )
    ).toBe(true);
    expect(events.at(-1)?.type).toBe("run_completed");
  });

  it("turns shell exceptions into failed command events that the agent can recover from", async () => {
    const events = await runAgentLoop({
      conversationId: "conv_throw",
      userMessage: "Try a command that crashes the shell wrapper.",
      provider: {
        async decide(params) {
          if (params.iteration === 0) {
            return {
              reasoning: "Attempt the command once.",
              plan: [{ id: "attempt", title: "Attempt the command", status: "in_progress" }],
              action: {
                type: "run_command",
                command: "bad-command",
                cwd: "."
              }
            };
          }

          expect(params.recentExecutions).toHaveLength(1);
          expect(params.recentExecutions[0]?.exitCode).toBe(1);
          expect(params.recentExecutions[0]?.outputPreview).toContain("shell exploded");
          expect(params.consecutiveCommandFailures).toBe(1);

          return {
            reasoning: "Report the failure instead of hanging.",
            plan: [{ id: "attempt", title: "Attempt the command", status: "blocked" }],
            action: {
              type: "final_answer",
              message: "The command wrapper failed immediately."
            }
          };
        }
      },
      shell: {
        async run() {
          throw new Error("shell exploded");
        }
      }
    });

    expect(events.some((event) => event.type === "run_failed")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "command_completed" &&
          event.execution.exitCode === 1 &&
          event.execution.outputPreview.includes("shell exploded")
      )
    ).toBe(true);
    expect(events.at(-1)?.type).toBe("run_completed");
  });
});
