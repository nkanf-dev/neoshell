import type { AgentEvent, CommandExecution, Message, PlanStep } from "@neoshell/shared";

export type ShellMode = "agent" | "terminal";
export type StreamState = "idle" | "connecting" | "open" | "closed" | "error";
export type TurnState = "idle" | "queued" | "running" | "thinking" | "planning" | "executing" | "completed" | "failed";

export type ConversationRuntime = {
  turnState: TurnState;
  streamState: StreamState;
  activeRunId: string | null;
  currentCwd: string | null;
  lastEventAt: string | null;
  lastEventLabel: string;
  lastError: string | null;
  queuedAt: string | null;
  draftAssistant: string;
};

export type ConversationSurfaceState = {
  messages: Message[];
  plan: PlanStep[];
  commands: CommandExecution[];
  events: AgentEvent[];
  runtime: ConversationRuntime;
};

export type MessageTurnStatus = "queued" | "running" | "failed";

export function createConversationRuntime(): ConversationRuntime {
  return {
    turnState: "idle",
    streamState: "idle",
    activeRunId: null,
    currentCwd: null,
    lastEventAt: null,
    lastEventLabel: "Idle",
    lastError: null,
    queuedAt: null,
    draftAssistant: ""
  };
}

export function createEmptyConversationSurfaceState(): ConversationSurfaceState {
  return {
    messages: [],
    plan: [],
    commands: [],
    events: [],
    runtime: createConversationRuntime()
  };
}

export function markConversationQueued(runtime: ConversationRuntime): ConversationRuntime {
  return {
    ...runtime,
    turnState: "queued",
    activeRunId: runtime.activeRunId,
    lastError: null,
    queuedAt: new Date().toISOString(),
    lastEventLabel: "Queued"
  };
}

export function eventKey(event: AgentEvent) {
  return JSON.stringify(event);
}

export function describeEvent(event: AgentEvent) {
  switch (event.type) {
    case "run_started":
      return "Run started";
    case "plan_updated":
      return `Plan updated (${event.steps.length})`;
    case "thinking":
      return `Thinking: ${truncate(event.text, 72)}`;
    case "message_delta":
      return "Assistant streaming";
    case "command_started":
      return `Command started: ${truncate(event.command, 56)}`;
    case "command_completed":
      return `Command finished: exit ${event.execution.exitCode}`;
    case "assistant_message":
      return "Assistant message committed";
    case "run_completed":
      return "Run completed";
    case "run_failed":
      return `Run failed: ${event.error}`;
    default:
      return "Event";
  }
}

export function formatRelativeTime(value: string | null, now = Date.now()) {
  if (!value) return "never";

  const diffMs = Math.max(0, now - new Date(value).getTime());
  if (diffMs < 5_000) return "just now";
  if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`;
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  return `${Math.floor(diffMs / 3_600_000)}h ago`;
}

export function formatAbsoluteTime(value: string | null) {
  if (!value) return "never";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function reduceAgentEvents(events: AgentEvent[]) {
  let runtime = createConversationRuntime();
  const plan: PlanStep[] = [];
  const commands: CommandExecution[] = [];
  let draftAssistant = "";

  for (const event of events) {
    runtime = reduceRuntime(runtime, event);
    if (event.type === "plan_updated") {
      plan.splice(0, plan.length, ...event.steps);
    }
    if (event.type === "command_completed") {
      commands.push(event.execution);
    }
    if (event.type === "message_delta") {
      draftAssistant += event.text;
    }
    if (event.type === "assistant_message") {
      draftAssistant = "";
    }
  }

  return {
    runtime: {
      ...runtime,
      draftAssistant
    },
    plan,
    commands
  };
}

export function reduceRuntime(runtime: ConversationRuntime, event: AgentEvent): ConversationRuntime {
  const lastEventLabel = describeEvent(event);

  switch (event.type) {
    case "run_started":
      return {
        ...runtime,
        turnState: "running",
        activeRunId: event.runId,
        lastEventAt: event.at,
        lastEventLabel,
        lastError: null
      };
    case "plan_updated":
      return {
        ...runtime,
        turnState: "planning",
        lastEventAt: event.at,
        lastEventLabel,
        lastError: null
      };
    case "thinking":
      return {
        ...runtime,
        turnState: "thinking",
        activeRunId: event.runId,
        lastEventAt: event.at,
        lastEventLabel,
        lastError: null
      };
    case "message_delta":
      return {
        ...runtime,
        turnState: runtime.turnState === "thinking" ? "thinking" : "running",
        activeRunId: event.runId,
        lastEventAt: event.at,
        lastEventLabel,
        lastError: null,
        draftAssistant: `${runtime.draftAssistant}${event.text}`
      };
    case "command_started":
      return {
        ...runtime,
        turnState: "executing",
        activeRunId: event.runId,
        currentCwd: event.cwd,
        lastEventAt: event.at,
        lastEventLabel,
        lastError: null
      };
    case "command_completed":
      return {
        ...runtime,
        turnState: "running",
        activeRunId: event.runId,
        currentCwd: event.execution.currentCwd ?? runtime.currentCwd,
        lastEventAt: event.at,
        lastEventLabel,
        lastError: null
      };
    case "assistant_message":
      return {
        ...runtime,
        turnState: "running",
        activeRunId: event.runId,
        lastEventAt: event.at,
        lastEventLabel,
        lastError: null,
        draftAssistant: ""
      };
    case "run_completed":
      return {
        ...runtime,
        turnState: "completed",
        activeRunId: null,
        queuedAt: null,
        lastEventAt: event.at,
        lastEventLabel,
        lastError: null,
        draftAssistant: ""
      };
    case "run_failed":
      return {
        ...runtime,
        turnState: "failed",
        activeRunId: null,
        queuedAt: null,
        lastEventAt: event.at,
        lastEventLabel,
        lastError: event.error,
        draftAssistant: ""
      };
    default:
      return runtime;
  }
}

export function turnStatusLabel(status: TurnState) {
  switch (status) {
    case "idle":
      return "Idle";
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "thinking":
      return "Thinking";
    case "planning":
      return "Planning";
    case "executing":
      return "Executing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

export function buildUserMessageTurnStatusMap(
  messages: Message[],
  events: AgentEvent[],
  runtime: ConversationRuntime
) {
  const statusByRunId = new Map<string, TurnState>();
  const queuedAgentRuns: Array<{ runId: string; messageId?: string }> = [];

  for (const event of events) {
    switch (event.type) {
      case "run_queued":
        if (event.channel === "agent") {
          queuedAgentRuns.push({
            runId: event.runId,
            messageId: event.messageId
          });
          statusByRunId.set(event.runId, "queued");
        }
        break;
      case "run_started":
      case "thinking":
      case "plan_updated":
      case "message_delta":
      case "command_started":
      case "command_completed":
      case "assistant_message":
        if (event.channel === "agent" || statusByRunId.has(event.runId)) {
          statusByRunId.set(event.runId, "running");
        }
        break;
      case "run_completed":
        if (event.channel === "agent" || statusByRunId.has(event.runId)) {
          statusByRunId.set(event.runId, "completed");
        }
        break;
      case "run_failed":
        if (event.channel === "agent" || statusByRunId.has(event.runId)) {
          statusByRunId.set(event.runId, "failed");
        }
        break;
      default:
        break;
    }
  }

  const userMessages = messages.filter((message) => message.role === "user");
  const explicitRunIdByMessageId = new Map<string, string>();
  const fallbackRuns: string[] = [];

  for (const queuedRun of queuedAgentRuns) {
    if (queuedRun.messageId) {
      explicitRunIdByMessageId.set(queuedRun.messageId, queuedRun.runId);
      continue;
    }
    fallbackRuns.push(queuedRun.runId);
  }

  const runIdByMessageId = new Map<string, string>();
  let fallbackIndex = 0;
  for (const message of userMessages) {
    const explicitRunId = explicitRunIdByMessageId.get(message.id);
    if (explicitRunId) {
      runIdByMessageId.set(message.id, explicitRunId);
      continue;
    }

    const fallbackRunId = fallbackRuns[fallbackIndex];
    if (fallbackRunId) {
      runIdByMessageId.set(message.id, fallbackRunId);
      fallbackIndex += 1;
    }
  }

  const statusByMessageId: Record<string, MessageTurnStatus> = {};
  for (const message of userMessages) {
    const runId = runIdByMessageId.get(message.id);
    if (!runId) {
      continue;
    }

    const status = toMessageTurnStatus(statusByRunId.get(runId));
    if (status) {
      statusByMessageId[message.id] = status;
    }
  }

  const lastUserMessage = userMessages.at(-1);
  if (lastUserMessage && !runIdByMessageId.has(lastUserMessage.id)) {
    const fallbackStatus = toMessageTurnStatus(runtime.turnState);
    if (fallbackStatus) {
      statusByMessageId[lastUserMessage.id] = fallbackStatus;
    }
  }

  return statusByMessageId;
}

function toMessageTurnStatus(status: TurnState | undefined): MessageTurnStatus | null {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
    case "thinking":
    case "planning":
    case "executing":
      return "running";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

export function streamStatusLabel(status: StreamState) {
  switch (status) {
    case "idle":
      return "Idle";
    case "connecting":
      return "Connecting";
    case "open":
      return "Live";
    case "closed":
      return "Closed";
    case "error":
      return "Error";
    default:
      return status;
  }
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}...`;
}
