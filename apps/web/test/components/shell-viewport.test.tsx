import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Conversation } from "@neoshell/shared";

import type { ConversationSurfaceState } from "../../src/lib/control-plane";
import { demoCommands, demoConversations, demoMessages, demoPlan } from "../../src/lib/demo-data";
import { ShellViewport } from "../../src/components/shell-viewport";

const VIEWPORT_SETTINGS_STORAGE_KEY = "neoshell.viewport.settings";
const TEST_CURRENT_CWD = "C:\\workspace\\neoshell";

function createState(): ConversationSurfaceState {
  return {
    messages: demoMessages[demoConversations[0].id],
    plan: demoPlan,
    commands: demoCommands,
    events: [
      {
        type: "run_started",
        runId: "run_1",
        at: "2026-03-24T00:30:00.000Z",
        channel: "agent"
      },
      {
        type: "thinking",
        runId: "run_1",
        at: "2026-03-24T00:30:02.000Z",
        channel: "agent",
        text: "Checking workspace state"
      },
      {
        type: "message_delta",
        runId: "run_1",
        at: "2026-03-24T00:30:03.000Z",
        channel: "agent",
        text: "I will inspect the repo next."
      }
    ],
    runtime: {
      turnState: "thinking",
      streamState: "open",
      activeRunId: "run_1",
      currentCwd: TEST_CURRENT_CWD,
      lastEventAt: "2026-03-24T00:30:03.000Z",
      lastEventLabel: "Assistant streaming",
      lastError: null,
      queuedAt: "2026-03-24T00:30:00.000Z",
      draftAssistant: "I will inspect the repo next."
    }
  };
}

function createFailedTurnState(): ConversationSurfaceState {
  return {
    messages: [
      {
        id: "user_ok",
        conversationId: demoConversations[0].id,
        role: "user",
        content: "Inspect the workspace",
        createdAt: "2026-03-24T00:20:00.000Z"
      },
      {
        id: "assistant_ok",
        conversationId: demoConversations[0].id,
        role: "assistant",
        content: "Workspace inspected.",
        createdAt: "2026-03-24T00:20:04.000Z"
      },
      {
        id: "user_failed",
        conversationId: demoConversations[0].id,
        role: "user",
        content: "This failed",
        createdAt: "2026-03-24T00:21:00.000Z"
      }
    ],
    plan: [],
    commands: [],
    events: [
      {
        type: "run_queued",
        runId: "run_ok",
        at: "2026-03-24T00:20:00.000Z",
        channel: "agent",
        messageId: "user_ok"
      },
      {
        type: "run_started",
        runId: "run_ok",
        at: "2026-03-24T00:20:01.000Z",
        channel: "agent"
      },
      {
        type: "assistant_message",
        runId: "run_ok",
        at: "2026-03-24T00:20:04.000Z",
        channel: "agent",
        message: {
          id: "assistant_ok",
          conversationId: demoConversations[0].id,
          role: "assistant",
          content: "Workspace inspected.",
          createdAt: "2026-03-24T00:20:04.000Z"
        }
      },
      {
        type: "run_completed",
        runId: "run_ok",
        at: "2026-03-24T00:20:05.000Z",
        channel: "agent"
      },
      {
        type: "run_queued",
        runId: "run_failed",
        at: "2026-03-24T00:21:00.000Z",
        channel: "agent",
        messageId: "user_failed"
      },
      {
        type: "run_started",
        runId: "run_failed",
        at: "2026-03-24T00:21:01.000Z",
        channel: "agent"
      },
      {
        type: "run_failed",
        runId: "run_failed",
        at: "2026-03-24T00:21:03.000Z",
        channel: "agent",
        error: "Command failed"
      }
    ],
    runtime: {
      turnState: "failed",
      streamState: "open",
      activeRunId: null,
      currentCwd: TEST_CURRENT_CWD,
      lastEventAt: "2026-03-24T00:21:03.000Z",
      lastEventLabel: "Run failed: Command failed",
      lastError: "Command failed",
      queuedAt: null,
      draftAssistant: ""
    }
  };
}

function renderViewport(overrides: Partial<React.ComponentProps<typeof ShellViewport>> = {}) {
  const props: React.ComponentProps<typeof ShellViewport> = {
    session: { userId: "u1", username: "operator", expiresAt: "2026-03-24T01:00:00.000Z" },
    conversations: demoConversations,
    currentConversation: demoConversations[0],
    selectedConversationId: demoConversations[0].id,
    state: createState(),
    mode: "agent",
    providers: [],
    selectedProviderId: "default",
    globalError: null,
    isBusy: false,
    onModeChange: vi.fn(),
    onSelectProvider: vi.fn(),
    onSelectConversation: vi.fn(),
    onNewConversation: vi.fn(),
    onRenameConversation: vi.fn(),
    onSetConversationArchived: vi.fn(),
    onClearThread: vi.fn(),
    onSendAgentMessage: vi.fn(),
    onExecuteTerminal: vi.fn(),
    onLogout: vi.fn(),
    ...overrides
  };

  render(<ShellViewport {...props} />);
  return props;
}

describe("ShellViewport", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders compact control plane panels and keeps archived threads visible", () => {
    renderViewport();

    expect(screen.getByRole("button", { name: /new conversation/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear thread/i })).toBeInTheDocument();
    expect(screen.getByText("Plan surface")).toBeInTheDocument();
    expect(screen.getByText("Observability")).toBeInTheDocument();
    expect(screen.getByText("Streaming")).toBeInTheDocument();
    expect(screen.getByText("Prompt iteration")).toBeInTheDocument();
  });

  it("marks failed status on the failed user message instead of the conversation row", () => {
    renderViewport({
      state: createFailedTurnState()
    });

    const failedMessage = screen.getByText("This failed").closest("article");
    expect(failedMessage).not.toBeNull();
    expect(within(failedMessage as HTMLElement).getByText("failed")).toBeInTheDocument();
    expect(screen.queryByText("Failed thread")).not.toBeInTheDocument();
  });

  it("switches between agent and terminal mode and confirms before clearing a thread", async () => {
    const onModeChange = vi.fn();
    const onNewConversation = vi.fn();
    const onClearThread = vi.fn();

    renderViewport({
      onModeChange,
      onNewConversation,
      onClearThread
    });

    await userEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(onModeChange).toHaveBeenCalledWith("terminal");

    await userEvent.click(screen.getByRole("button", { name: /new conversation/i }));
    expect(onNewConversation).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: /clear thread/i }));
    expect(onClearThread).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: /clear current thread/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^clear thread$/i }));
    expect(onClearThread).toHaveBeenCalledTimes(1);
  });

  it("opens settings in a dialog and persists the auto-scroll toggle", async () => {
    renderViewport();

    await userEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.getByRole("dialog", { name: /settings/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /toggle auto-scroll to latest/i }));

    await waitFor(() => {
      expect(window.localStorage.getItem(VIEWPORT_SETTINGS_STORAGE_KEY)).toContain('"autoScrollToLatest":false');
    });
  });

  it("renames the current conversation and confirms archive before applying it", async () => {
    const onRenameConversation = vi.fn();
    const onSetConversationArchived = vi.fn();

    renderViewport({
      onRenameConversation,
      onSetConversationArchived
    });

    await userEvent.click(screen.getByRole("button", { name: /rename/i }));
    const titleInput = screen.getByLabelText("Title");
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Workspace review");
    await userEvent.click(screen.getByRole("button", { name: /save title/i }));

    expect(onRenameConversation).toHaveBeenCalledWith(demoConversations[0].id, "Workspace review");

    await userEvent.click(screen.getByRole("button", { name: /^archive$/i }));
    expect(onSetConversationArchived).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: /archive conversation/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /archive conversation/i }));
    expect(onSetConversationArchived).toHaveBeenCalledWith(demoConversations[0].id, true);
  });

  it("submits with Enter and keeps Shift+Enter as newline", async () => {
    const onSendAgentMessage = vi.fn();

    renderViewport({
      onSendAgentMessage
    });

    const composer = screen.getByPlaceholderText("Ask the agent to inspect, plan, and execute.");
    await userEvent.clear(composer);
    await userEvent.type(composer, "Line 1");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}Line 2");

    expect(onSendAgentMessage).not.toHaveBeenCalled();
    expect(composer).toHaveValue("Line 1\nLine 2");

    await userEvent.keyboard("{Enter}");
    expect(onSendAgentMessage).toHaveBeenCalledWith(demoConversations[0].id, "Line 1\nLine 2");
  });

  it("shows restore controls for archived current conversations", () => {
    const archivedConversation: Conversation = {
      ...demoConversations[2],
      archivedAt: "2026-03-24T00:45:00.000Z"
    };

    renderViewport({
      conversations: [
        archivedConversation,
        ...demoConversations.filter((conversation) => conversation.id !== archivedConversation.id)
      ],
      currentConversation: archivedConversation,
      selectedConversationId: archivedConversation.id
    });

    expect(screen.getByRole("button", { name: /restore/i })).toBeInTheDocument();
  });
});
