import type { CommandExecution, Conversation, Message, PlanStep } from "@neoshell/shared";

const DEMO_WORKSPACE_ROOT = "C:\\workspace\\neoshell";

export const demoConversation: Conversation = {
  id: "conv_demo",
  title: "Local PowerShell bootstrap",
  titleSource: "manual",
  archivedAt: null,
  lastRunStatus: "completed",
  createdAt: "2026-03-24T00:00:00.000Z",
  updatedAt: "2026-03-24T00:30:00.000Z"
};

export const demoConversations: Conversation[] = [
  demoConversation,
  {
    id: "conv_ops",
    title: "Remote access hardening",
    titleSource: "manual",
    archivedAt: null,
    lastRunStatus: "failed",
    createdAt: "2026-03-23T18:00:00.000Z",
    updatedAt: "2026-03-24T00:15:00.000Z"
  },
  {
    id: "conv_docs",
    title: "Prompt iteration",
    titleSource: "auto",
    archivedAt: "2026-03-24T00:45:00.000Z",
    lastRunStatus: "completed",
    createdAt: "2026-03-22T09:15:00.000Z",
    updatedAt: "2026-03-23T19:20:00.000Z"
  }
];

export const demoMessages: Record<string, Message[]> = {
  conv_demo: [
    {
      id: "msg_1",
      conversationId: "conv_demo",
      role: "system",
      content: "You are neoshell. Be explicit, safe, and inspect before mutating.",
      createdAt: "2026-03-24T00:00:00.000Z"
    },
    {
      id: "msg_2",
      conversationId: "conv_demo",
      role: "assistant",
      content: "I will check the workspace state, then propose the smallest safe next step.",
      createdAt: "2026-03-24T00:05:00.000Z"
    },
    {
      id: "msg_3",
      conversationId: "conv_demo",
      role: "user",
      content: "Verify the current workspace layout and shell the agent should use.",
      createdAt: "2026-03-24T00:08:00.000Z"
    }
  ]
};

export const demoPlan: PlanStep[] = [
  { id: "inspect", title: "Inspect repository state", status: "completed" },
  { id: "design", title: "Design frontend shell", status: "completed" },
  { id: "integrate", title: "Wire backend endpoints", status: "in_progress" }
];

export const demoCommands: CommandExecution[] = [
  {
    id: "cmd_1",
    command: "git status --short --branch",
    cwd: DEMO_WORKSPACE_ROOT,
    exitCode: 0,
    truncated: false,
    outputPreview: "## codex/bootstrap-neoshell",
    durationMs: 18
  },
  {
    id: "cmd_2",
    command: "Get-ChildItem apps/web",
    cwd: DEMO_WORKSPACE_ROOT,
    exitCode: 0,
    truncated: false,
    outputPreview: "app, src, package.json, tsconfig.json",
    durationMs: 12
  }
];
