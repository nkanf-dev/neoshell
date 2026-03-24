import React, { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { AgentEvent, AuthSession, Conversation, Message, ProviderConfig } from "@neoshell/shared";

import { authApi, conversationApi, messageApi, providersApi, terminalApi, ApiError, streamEvents } from "../lib/api";
import { demoCommands, demoConversations, demoMessages, demoPlan } from "../lib/demo-data";
import {
  createConversationRuntime,
  createEmptyConversationSurfaceState,
  eventKey,
  formatAbsoluteTime,
  markConversationQueued,
  reduceAgentEvents,
  reduceRuntime,
  type ConversationRuntime,
  type ConversationSurfaceState,
  type ShellMode
} from "../lib/control-plane";
import { LoginScreen } from "./login-screen";
import { ShellViewport } from "./shell-viewport";

type AuthState = {
  session: AuthSession | null;
  loading: boolean;
};

type ConversationStateMap = Record<string, ConversationSurfaceState>;

function createSeedState(conversationId: string): ConversationSurfaceState {
  if (conversationId === demoConversations[0].id) {
    return {
      messages: demoMessages[conversationId] ?? [],
      plan: demoPlan,
      commands: demoCommands,
      events: [],
      runtime: createConversationRuntime()
    };
  }

  return createEmptyConversationSurfaceState();
}

function createConversationStateFromDetail(
  current: ConversationSurfaceState,
  messages: Message[],
  events: AgentEvent[]
): ConversationSurfaceState {
  const mergedMessages = mergeMessages(current.messages, messages);
  const mergedEvents = mergeEvents(current.events, events);
  const snapshot = reduceAgentEvents(mergedEvents);

  return {
    messages: mergedMessages.length > 0 ? mergedMessages : current.messages,
    plan: snapshot.plan.length > 0 ? snapshot.plan : current.plan,
    commands: snapshot.commands.length > 0 ? snapshot.commands : current.commands,
    events: mergedEvents.length > 0 ? mergedEvents : current.events,
    runtime: mergeRuntime(current.runtime, snapshot.runtime)
  };
}

function mergeRuntime(current: ConversationRuntime, snapshot: ConversationRuntime) {
  const turnState =
    current.turnState !== "idle" && snapshot.turnState === "idle" ? current.turnState : snapshot.turnState;

  return {
    ...snapshot,
    turnState,
    streamState: current.streamState,
    currentCwd: snapshot.currentCwd ?? current.currentCwd,
    queuedAt: snapshot.queuedAt ?? current.queuedAt,
    lastError: snapshot.lastError ?? current.lastError,
    draftAssistant: snapshot.draftAssistant || current.draftAssistant
  };
}

function mergeMessages(current: Message[], incoming: Message[]) {
  if (incoming.length === 0) {
    return current;
  }

  const seen = new Set(current.map((message) => message.id));
  const next = [...current];
  for (const message of incoming) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    next.push(message);
  }
  return next;
}

function mergeEvents(current: AgentEvent[], incoming: AgentEvent[]) {
  if (incoming.length === 0) {
    return current;
  }

  const seen = new Set(current.map((event) => eventKey(event)));
  const next = [...current];
  for (const event of incoming) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(event);
  }
  return next;
}

function emptyStateFromSeed(conversationId: string) {
  return conversationId === demoConversations[0].id ? createSeedState(conversationId) : createEmptyConversationSurfaceState();
}

function upsertConversationSummary(current: Conversation[], nextConversation: Conversation) {
  let found = false;
  const next = current.map((conversation) => {
    if (conversation.id !== nextConversation.id) {
      return conversation;
    }
    found = true;
    return nextConversation;
  });

  return found ? next : [nextConversation, ...next];
}

function updateConversationSummaryState(
  current: Conversation[],
  conversationId: string,
  patch: Partial<Conversation>
) {
  return current.map((conversation) =>
    conversation.id === conversationId
      ? {
          ...conversation,
          ...patch
        }
      : conversation
  );
}

export function NeoShellApp() {
  const [auth, setAuth] = useState<AuthState>({ session: null, loading: true });
  const [conversations, setConversations] = useState<Conversation[]>(demoConversations);
  const [selectedConversationId, setSelectedConversationId] = useState(demoConversations[0].id);
  const [conversationStateById, setConversationStateById] = useState<ConversationStateMap>({
    [demoConversations[0].id]: createSeedState(demoConversations[0].id)
  });
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("default");
  const [mode, setMode] = useState<ShellMode>("agent");
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const streamAbortRef = useRef<AbortController | null>(null);
  const eventKeysRef = useRef<Record<string, Set<string>>>({
    [demoConversations[0].id]: new Set()
  });

  const currentConversation = conversations.find((conversation) => conversation.id === selectedConversationId) ?? null;
  const currentState = conversationStateById[selectedConversationId] ?? emptyStateFromSeed(selectedConversationId);

  const patchConversationState = useCallback(
    (conversationId: string, updater: (current: ConversationSurfaceState) => ConversationSurfaceState) => {
      setConversationStateById((current) => {
        const existing = current[conversationId] ?? emptyStateFromSeed(conversationId);
        return {
          ...current,
          [conversationId]: updater(existing)
        };
      });
    },
    []
  );

  const applyEvents = useCallback(
    (conversationId: string, incomingEvents: AgentEvent[]) => {
      if (incomingEvents.length === 0) return;

      patchConversationState(conversationId, (current) => {
        const knownKeys = eventKeysRef.current[conversationId] ?? new Set(current.events.map((event) => eventKey(event)));
        let events = current.events;
        let plan = current.plan;
        let commands = current.commands;
        let messages = current.messages;
        let runtime = current.runtime;
        let changed = false;

        for (const event of incomingEvents) {
          const key = eventKey(event);
          if (knownKeys.has(key)) {
            continue;
          }

          knownKeys.add(key);
          changed = true;
          events = [...events, event];
          runtime = reduceRuntime(runtime, event);

          if (event.type === "plan_updated") {
            plan = event.steps;
          }

          if (event.type === "command_completed" && !commands.some((command) => command.id === event.execution.id)) {
            commands = [...commands, event.execution];
          }

          if (event.type === "assistant_message" && !messages.some((message) => message.id === event.message.id)) {
            messages = [...messages, event.message];
          }
        }

        eventKeysRef.current[conversationId] = knownKeys;
        return changed ? { ...current, events, plan, commands, messages, runtime } : current;
      });

      setConversations((current) =>
        current.map((conversation) => {
          if (conversation.id !== conversationId) {
            return conversation;
          }

          const lastRunEvent = [...incomingEvents]
            .reverse()
            .find((event) => event.type === "run_completed" || event.type === "run_failed");

          if (!lastRunEvent) {
            return conversation;
          }

          return {
            ...conversation,
            lastRunStatus: lastRunEvent.type === "run_failed" ? "failed" : "completed",
            updatedAt: lastRunEvent.at
          };
        })
      );
    },
    [patchConversationState]
  );

  const syncConversationDetail = useCallback(
    async (conversationId: string) => {
      const detail = await conversationApi.get(conversationId);
      setConversations((current) => upsertConversationSummary(current, detail.conversation));
      patchConversationState(conversationId, (current) => {
        const nextState = createConversationStateFromDetail(current, detail.messages, detail.events);
        eventKeysRef.current[conversationId] = new Set(nextState.events.map((event) => eventKey(event)));
        return nextState;
      });
    },
    [patchConversationState]
  );

  const startConversationStream = useCallback(
    async (conversationId: string, controller: AbortController) => {
      patchConversationState(conversationId, (current) => ({
        ...current,
        runtime: {
          ...current.runtime,
          streamState: "connecting",
          lastError: null
        }
      }));

      try {
        let firstEventSeen = false;
        for await (const event of streamEvents(conversationId, controller.signal)) {
          if (controller.signal.aborted) {
            return;
          }

          if (!firstEventSeen) {
            firstEventSeen = true;
            patchConversationState(conversationId, (current) => ({
              ...current,
              runtime: {
                ...current.runtime,
                streamState: "open"
              }
            }));
          }

          applyEvents(conversationId, [event]);
        }

        if (!controller.signal.aborted) {
          patchConversationState(conversationId, (current) => ({
            ...current,
            runtime: {
              ...current.runtime,
              streamState: "closed"
            }
          }));
        }
      } catch (cause) {
        if (controller.signal.aborted) {
          return;
        }

        const message = cause instanceof Error ? cause.message : "SSE stream failed";
        patchConversationState(conversationId, (current) => ({
          ...current,
          runtime: {
            ...current.runtime,
            streamState: "error",
            lastError: message
          }
        }));
      }
    },
    [applyEvents, patchConversationState]
  );

  useEffect(() => {
    let active = true;

    async function loadSession() {
      try {
        const session = await authApi.session();
        if (!active) return;

        setAuth({ session, loading: false });
        if (!session) {
          return;
        }

        const [availableProviders, loadedConversations] = await Promise.all([
          providersApi.list().catch(() => []),
          conversationApi.list().catch(() => [])
        ]);

        if (!active) return;

        setProviders(availableProviders);
        if (availableProviders.length > 0) {
          setSelectedProviderId(availableProviders[0].providerId);
        }

        let nextConversations = loadedConversations;
        if (nextConversations.length === 0) {
          const created = await conversationApi.create("New conversation").catch(() => null);
          nextConversations = created ? [created] : [];
        }

        if (!active) return;

        if (nextConversations.length > 0) {
          setConversations(nextConversations);
          setSelectedConversationId(nextConversations[0].id);
          setConversationStateById((current) => {
            const next = { ...current };
            for (const conversation of nextConversations) {
              if (!next[conversation.id]) {
                next[conversation.id] = emptyStateFromSeed(conversation.id);
              }
            }
            return next;
          });
        }
      } catch {
        if (active) {
          setAuth({ session: null, loading: false });
        }
      }
    }

    void loadSession();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!auth.session) {
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      return;
    }

    if (!selectedConversationId) {
      return;
    }

    const controller = new AbortController();
    streamAbortRef.current?.abort();
    streamAbortRef.current = controller;

    void syncConversationDetail(selectedConversationId).catch((cause) => {
      const message = cause instanceof Error ? cause.message : "Failed to load conversation";
      patchConversationState(selectedConversationId, (current) => ({
        ...current,
        runtime: {
          ...current.runtime,
          lastError: message
        }
      }));
    });

    void startConversationStream(selectedConversationId, controller);

    return () => {
      controller.abort();
    };
  }, [auth.session, patchConversationState, selectedConversationId, startConversationStream, syncConversationDetail]);

  useEffect(() => {
    if (!auth.session || !selectedConversationId) {
      return;
    }

    const runtime = conversationStateById[selectedConversationId]?.runtime;
    if (!runtime?.activeRunId || runtime.turnState === "completed" || runtime.turnState === "failed") {
      return;
    }

    const interval = window.setInterval(() => {
      void syncConversationDetail(selectedConversationId).catch(() => undefined);
    }, 1500);

    return () => {
      window.clearInterval(interval);
    };
  }, [
    auth.session,
    conversationStateById,
    selectedConversationId,
    syncConversationDetail
  ]);

  useEffect(() => {
    if (conversations.length === 0) {
      return;
    }

    if (!conversations.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(conversations[0].id);
    }
  }, [conversations, selectedConversationId]);

  async function handleLogin(username: string, password: string) {
    setGlobalError(null);
    const session = await authApi.login(username, password);
    const [availableProviders, loadedConversations] = await Promise.all([
      providersApi.list().catch(() => []),
      conversationApi.list().catch(() => [])
    ]);

    let nextConversations = loadedConversations;
    if (nextConversations.length === 0) {
      const created = await conversationApi.create("New conversation").catch(() => null);
      nextConversations = created ? [created] : [];
    }

    setAuth({ session, loading: false });
    setProviders(availableProviders);
    setSelectedProviderId(availableProviders[0]?.providerId ?? "default");
    setConversations(nextConversations.length > 0 ? nextConversations : demoConversations);
    setSelectedConversationId(nextConversations[0]?.id ?? demoConversations[0].id);
    setConversationStateById((current) => {
      const next = { ...current };
      const sourceConversations = nextConversations.length > 0 ? nextConversations : demoConversations;
      for (const conversation of sourceConversations) {
        if (!next[conversation.id]) {
          next[conversation.id] = emptyStateFromSeed(conversation.id);
        }
      }
      return next;
    });
  }

  async function handleLogout() {
    setGlobalError(null);
    await authApi.logout().catch(() => undefined);
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setAuth({ session: null, loading: false });
    setConversations(demoConversations);
    setSelectedConversationId(demoConversations[0].id);
    setConversationStateById({
      [demoConversations[0].id]: createSeedState(demoConversations[0].id)
    });
    eventKeysRef.current = {
      [demoConversations[0].id]: new Set()
    };
    setProviders([]);
    setSelectedProviderId("default");
    setMode("agent");
  }

  function handleSelectConversation(conversationId: string) {
    setGlobalError(null);
    startTransition(() => {
      setSelectedConversationId(conversationId);
    });
  }

  function handleSelectMode(nextMode: ShellMode) {
    setGlobalError(null);
    setMode(nextMode);
  }

  async function handleNewConversation() {
    setGlobalError(null);
    try {
      const created = await conversationApi.create("New conversation");
      setConversations((current) => [created, ...current.filter((conversation) => conversation.id !== created.id)]);
      setConversationStateById((current) => ({
        ...current,
        [created.id]: createEmptyConversationSurfaceState()
      }));
      eventKeysRef.current[created.id] = new Set();
      startTransition(() => {
        setSelectedConversationId(created.id);
      });
    } catch (cause) {
      setGlobalError(cause instanceof Error ? cause.message : "Failed to create a new conversation");
    }
  }

  async function handleRenameConversation(conversationId: string, title: string) {
    setGlobalError(null);

    try {
      const updated = await conversationApi.update(conversationId, { title });
      setConversations((current) => current.map((conversation) => (conversation.id === conversationId ? updated : conversation)));
    } catch (cause) {
      setGlobalError(cause instanceof Error ? cause.message : "Failed to rename the conversation");
    }
  }

  async function handleSetConversationArchived(conversationId: string, archived: boolean) {
    setGlobalError(null);

    try {
      const updated = await conversationApi.update(conversationId, { archived });
      setConversations((current) =>
        current.map((conversation) => (conversation.id === conversationId ? updated : conversation))
      );
    } catch (cause) {
      setGlobalError(cause instanceof Error ? cause.message : "Failed to update the conversation archive state");
    }
  }

  async function handleClearThread() {
    const conversationId = selectedConversationId;
    if (!conversationId) return;

    setGlobalError(null);

    try {
      const reset = await conversationApi.reset(conversationId);
      setConversations((current) => current.map((conversation) => (conversation.id === conversationId ? reset.conversation : conversation)));
      patchConversationState(conversationId, () => ({
        ...createEmptyConversationSurfaceState(),
        runtime: {
          ...createConversationRuntime(),
          currentCwd: selectedConversationId ? currentState.runtime.currentCwd : null
        }
      }));
      eventKeysRef.current[conversationId] = new Set();
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 405 || cause.status === 501)) {
        patchConversationState(conversationId, (current) => ({
          ...current,
          messages: [],
          plan: [],
          commands: [],
          events: [],
          runtime: {
            ...createConversationRuntime(),
            streamState: current.runtime.streamState,
            currentCwd: current.runtime.currentCwd,
            lastEventLabel: "Thread cleared locally"
          }
        }));
        eventKeysRef.current[conversationId] = new Set();
        return;
      }

      setGlobalError(cause instanceof Error ? cause.message : "Failed to clear the thread");
    }
  }

  async function handleSendAgentMessage(conversationId: string, content: string) {
    setGlobalError(null);
    const now = new Date().toISOString();
    const pendingMessageId = `pending_${Date.now()}`;
    patchConversationState(conversationId, (current) => ({
      ...current,
      messages: [
        ...current.messages,
        {
          id: pendingMessageId,
          conversationId,
          role: "user",
          content,
          createdAt: now
        }
      ],
      runtime: markConversationQueued(current.runtime)
    }));

    try {
      const response = await messageApi.send({
        conversationId,
        content,
        providerId: selectedProviderId
      });
      patchConversationState(conversationId, (current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingMessageId ? response.message : message
        ),
        runtime: {
          ...current.runtime,
          turnState: "queued",
          activeRunId: response.runId,
          queuedAt: response.queuedAt,
          lastEventLabel: "Queued",
          currentCwd: current.runtime.currentCwd
        }
      }));
    } catch (cause) {
      const failedAt = new Date().toISOString();
      setConversations((current) =>
        updateConversationSummaryState(current, conversationId, {
          lastRunStatus: "failed",
          updatedAt: failedAt
        })
      );
      patchConversationState(conversationId, (current) => ({
        ...current,
        runtime: {
          ...current.runtime,
          turnState: "failed",
          lastError: cause instanceof Error ? cause.message : "Agent turn failed"
        }
      }));
    }
  }

  async function handleExecuteTerminal(conversationId: string, command: string, cwd: string) {
    setGlobalError(null);
    patchConversationState(conversationId, (current) => ({
      ...current,
      runtime: {
        ...markConversationQueued(current.runtime),
        currentCwd: cwd
      }
    }));

    try {
      const response = await terminalApi.execute({
        conversationId,
        command,
        cwd,
        providerId: selectedProviderId
      });
      patchConversationState(conversationId, (current) => ({
        ...current,
        runtime: {
          ...current.runtime,
          turnState: "queued",
          activeRunId: response.runId,
          queuedAt: response.queuedAt,
          currentCwd: response.currentCwd,
          lastEventLabel: "Queued"
        }
      }));
    } catch (cause) {
      const failedAt = new Date().toISOString();
      setConversations((current) =>
        updateConversationSummaryState(current, conversationId, {
          lastRunStatus: "failed",
          updatedAt: failedAt
        })
      );
      patchConversationState(conversationId, (current) => ({
        ...current,
        runtime: {
          ...current.runtime,
          turnState: "failed",
          lastError: cause instanceof Error ? cause.message : "Terminal execution failed"
        }
      }));
    }
  }

  if (auth.loading) {
    return <ShellLoadingState />;
  }

  if (!auth.session) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <ShellViewport
      session={auth.session}
      conversations={conversations}
      currentConversation={currentConversation}
      selectedConversationId={selectedConversationId}
      state={currentState}
      mode={mode}
      providers={providers}
      selectedProviderId={selectedProviderId}
      globalError={globalError}
      isBusy={isPending}
      onModeChange={handleSelectMode}
      onSelectProvider={setSelectedProviderId}
      onSelectConversation={handleSelectConversation}
      onNewConversation={handleNewConversation}
      onRenameConversation={handleRenameConversation}
      onSetConversationArchived={handleSetConversationArchived}
      onClearThread={handleClearThread}
      onSendAgentMessage={handleSendAgentMessage}
      onExecuteTerminal={handleExecuteTerminal}
      onLogout={handleLogout}
    />
  );
}

function ShellLoadingState() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-sm">
        <div className="grid gap-3">
          <div className="text-sm font-medium uppercase tracking-[0.18em] text-muted-foreground">neoshell</div>
          <div className="text-2xl font-semibold tracking-tight">Preparing the control plane</div>
          <div className="text-sm text-muted-foreground">
            Session check, provider discovery, conversation hydration, and SSE bootstrap.
          </div>
          <div className="rounded-xl border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Connecting...
            <span className="ml-2 text-foreground">{formatAbsoluteTime(new Date().toISOString())}</span>
          </div>
        </div>
      </div>
    </main>
  );
}
