import { nanoid } from "nanoid";

import type {
  AgentDecision,
  AgentEvent,
  CommandExecution,
  EventChannel,
  Message,
  PlanStep
} from "@neoshell/shared";

export type AgentLoopProvider = {
  decide(params: {
    conversationId: string;
    userMessage: string;
    iteration: number;
    lastObservation?: string;
    plan: PlanStep[];
    conversationMessages: Message[];
    recentExecutions: CommandExecution[];
    consecutiveCommandFailures: number;
  }): Promise<AgentDecision>;
};

export type AgentLoopShell = {
  run(command: string, cwd: string): Promise<Omit<CommandExecution, "id">>;
};

export async function runAgentLoop(params: {
  conversationId: string;
  userMessage: string;
  maxIterations?: number;
  runId?: string;
  channel?: EventChannel;
  conversationMessages?: Message[];
  priorExecutions?: CommandExecution[];
  provider: AgentLoopProvider;
  shell: AgentLoopShell;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}): Promise<AgentEvent[]> {
  const runId = params.runId ?? nanoid();
  const channel = params.channel ?? "agent";
  const maxIterations = params.maxIterations ?? 6;
  const events: AgentEvent[] = [];
  const now = () => new Date().toISOString();
  let lastObservation: string | undefined;
  let plan: PlanStep[] = [];
  let consecutiveCommandFailures = 0;
  const conversationMessages = params.conversationMessages ?? [];
  const executionHistory = [...(params.priorExecutions ?? [])];

  const emit = async (event: AgentEvent) => {
    events.push(event);
    await params.onEvent?.(event);
  };

  await emit({
    type: "run_started",
    runId,
    at: now(),
    channel
  });

  try {
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const decision = await params.provider.decide({
        conversationId: params.conversationId,
        userMessage: params.userMessage,
        iteration,
        lastObservation,
        plan,
        conversationMessages,
        recentExecutions: executionHistory.slice(-8),
        consecutiveCommandFailures
      });

      plan = decision.plan;
      await emit({
        type: "plan_updated",
        runId,
        at: now(),
        channel,
        steps: decision.plan
      });

      if (decision.reasoning.trim().length > 0) {
        await emit({
          type: "thinking",
          runId,
          at: now(),
          channel,
          text: decision.reasoning
        });
      }

      if (decision.action.type === "run_command") {
        const commandId = nanoid();
        await emit({
          type: "command_started",
          runId,
          at: now(),
          channel,
          id: commandId,
          command: decision.action.command,
          cwd: decision.action.cwd
        });

        let execution: Omit<CommandExecution, "id">;
        try {
          execution = await params.shell.run(decision.action.command, decision.action.cwd);
        } catch (error) {
          execution = {
            command: decision.action.command,
            cwd: decision.action.cwd,
            exitCode: 1,
            timedOut: false,
            truncated: false,
            outputPreview: error instanceof Error ? error.message : "Command failed",
            durationMs: 0
          };
        }
        const completedExecution: CommandExecution = {
          id: commandId,
          ...execution
        };
        executionHistory.push(completedExecution);
        lastObservation = summarizeExecutionForObservation(completedExecution);
        consecutiveCommandFailures = completedExecution.exitCode === 0 ? 0 : consecutiveCommandFailures + 1;

        await emit({
          type: "command_completed",
          runId,
          at: now(),
          channel,
          execution: completedExecution
        });
        continue;
      }

      const message: Message = {
        id: nanoid(),
        conversationId: params.conversationId,
        role: "assistant",
        content: decision.action.message,
        createdAt: now()
      };

      await emit({
        type: "assistant_message",
        runId,
        at: now(),
        channel,
        message
      });
      await emit({
        type: "run_completed",
        runId,
        at: now(),
        channel
      });
      return events;
    }

    await emit({
      type: "run_failed",
      runId,
      at: now(),
      channel,
      error: `Agent exceeded ${maxIterations} iterations without producing a final answer`
    });
    return events;
  } catch (error) {
    await emit({
      type: "run_failed",
      runId,
      at: now(),
      channel,
      error: error instanceof Error ? error.message : "Unknown agent loop error"
    });
  }

  return events;
}

function summarizeExecutionForObservation(execution: CommandExecution) {
  return [
    `Command: ${execution.command}`,
    `Cwd: ${execution.cwd}`,
    `Exit code: ${execution.exitCode}`,
    `Timed out: ${execution.timedOut ? "yes" : "no"}`,
    execution.currentCwd ? `Current cwd: ${execution.currentCwd}` : undefined,
    "Output preview:",
    execution.outputPreview || "(no output)"
  ]
    .filter(Boolean)
    .join("\n");
}
