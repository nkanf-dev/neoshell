import React, { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AgentEvent, AuthSession, CommandExecution, Conversation, Message, ProviderConfig } from "@neoshell/shared";
import { Archive, ArchiveRestore, Loader2, PencilLine, Plus, Send, Settings2, Terminal, Trash2, Workflow } from "lucide-react";

import { initials } from "../lib/frontend";
import {
  buildUserMessageTurnStatusMap,
  formatAbsoluteTime,
  formatRelativeTime,
  type MessageTurnStatus,
  streamStatusLabel,
  turnStatusLabel,
  type ConversationRuntime,
  type ConversationSurfaceState,
  type ShellMode
} from "../lib/control-plane";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const VIEWPORT_SETTINGS_STORAGE_KEY = "neoshell.viewport.settings";

type ViewportSettings = {
  autoScrollToLatest: boolean;
};

type PendingConfirmAction =
  | {
      kind: "clear";
    }
  | {
      kind: "archive";
    };

type ShellViewportProps = {
  session: AuthSession;
  conversations: Conversation[];
  currentConversation: Conversation | null;
  selectedConversationId: string;
  state: ConversationSurfaceState;
  mode: ShellMode;
  providers: ProviderConfig[];
  selectedProviderId: string;
  globalError: string | null;
  isBusy: boolean;
  onModeChange: (mode: ShellMode) => void;
  onSelectProvider: (providerId: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onNewConversation: () => Promise<void> | void;
  onRenameConversation: (conversationId: string, title: string) => Promise<void> | void;
  onSetConversationArchived: (conversationId: string, archived: boolean) => Promise<void> | void;
  onClearThread: () => Promise<void> | void;
  onSendAgentMessage: (conversationId: string, content: string) => Promise<void> | void;
  onExecuteTerminal: (conversationId: string, command: string, cwd: string) => Promise<void> | void;
  onLogout: () => Promise<void> | void;
};

function loadViewportSettings(): ViewportSettings {
  if (typeof window === "undefined") {
    return {
      autoScrollToLatest: true
    };
  }

  try {
    const raw = window.localStorage.getItem(VIEWPORT_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {
        autoScrollToLatest: true
      };
    }

    const parsed = JSON.parse(raw) as Partial<ViewportSettings>;
    return {
      autoScrollToLatest: parsed.autoScrollToLatest ?? true
    };
  } catch {
    return {
      autoScrollToLatest: true
    };
  }
}

function getScrollViewport(root: HTMLDivElement | null) {
  if (!root) {
    return null;
  }

  return root.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement | null;
}

function scrollScrollAreaToBottom(root: HTMLDivElement | null) {
  const viewport = getScrollViewport(root);
  if (!viewport) {
    return;
  }

  viewport.scrollTop = viewport.scrollHeight;
}

export function ShellViewport({
  session,
  conversations,
  currentConversation,
  selectedConversationId,
  state,
  mode,
  providers,
  selectedProviderId,
  globalError,
  isBusy,
  onModeChange,
  onSelectProvider,
  onSelectConversation,
  onNewConversation,
  onRenameConversation,
  onSetConversationArchived,
  onClearThread,
  onSendAgentMessage,
  onExecuteTerminal,
  onLogout
}: ShellViewportProps) {
  const [terminalCommand, setTerminalCommand] = useState("Get-ChildItem");
  const [terminalCwd, setTerminalCwd] = useState(".");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingConfirmAction, setPendingConfirmAction] = useState<PendingConfirmAction | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [settings, setSettings] = useState<ViewportSettings>(() => loadViewportSettings());

  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const observabilityScrollRef = useRef<HTMLDivElement | null>(null);
  const commandLogScrollRef = useRef<HTMLDivElement | null>(null);
  const activeConversationButtonRef = useRef<HTMLButtonElement | null>(null);

  const selectedProviderLabel =
    providers.find((provider) => provider.providerId === selectedProviderId)?.label ?? "default";
  const runtime = state.runtime;
  const liveEvents = state.events.slice(-8);
  const activeConversations = conversations.filter((conversation) => conversation.archivedAt === null);
  const archivedConversations = conversations.filter((conversation) => conversation.archivedAt !== null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(VIEWPORT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    setRenameDraft(currentConversation?.title ?? "");
  }, [currentConversation?.id, currentConversation?.title]);

  useEffect(() => {
    if (!settings.autoScrollToLatest) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      scrollScrollAreaToBottom(conversationScrollRef.current);
      scrollScrollAreaToBottom(observabilityScrollRef.current);
      scrollScrollAreaToBottom(commandLogScrollRef.current);
      activeConversationButtonRef.current?.scrollIntoView({
        block: "end"
      });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    selectedConversationId,
    mode,
    settings.autoScrollToLatest,
    state.messages.length,
    state.events.length,
    state.commands.length
  ]);

  const modeTabs = useMemo(
    () => (
      <Tabs value={mode} onValueChange={(value) => onModeChange(value as ShellMode)} className="w-fit">
        <TabsList className="grid h-10 grid-cols-2 rounded-full bg-muted p-1">
          <TabsTrigger value="agent" className="rounded-full px-4">
            Agent
          </TabsTrigger>
          <TabsTrigger value="terminal" className="rounded-full px-4">
            Terminal
          </TabsTrigger>
        </TabsList>
      </Tabs>
    ),
    [mode, onModeChange]
  );

  async function handleRenameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentConversation || !renameDraft.trim()) {
      return;
    }

    await onRenameConversation(currentConversation.id, renameDraft.trim());
    setRenameOpen(false);
  }

  async function handleConfirmAction() {
    if (!pendingConfirmAction || confirmPending) {
      return;
    }

    setConfirmPending(true);
    try {
      if (pendingConfirmAction.kind === "clear") {
        await onClearThread();
      }

      if (pendingConfirmAction.kind === "archive" && currentConversation) {
        await onSetConversationArchived(currentConversation.id, true);
      }

      setPendingConfirmAction(null);
    } finally {
      setConfirmPending(false);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AlertDialog
        open={pendingConfirmAction !== null}
        onOpenChange={(open: boolean) => {
          if (!open && !confirmPending) {
            setPendingConfirmAction(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingConfirmAction?.kind === "archive" ? "Archive conversation?" : "Clear current thread?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingConfirmAction?.kind === "archive"
                ? `Archive "${currentConversation?.title ?? "this conversation"}". The thread will move into the archived section but remain available.`
                : "Clear the current thread history, plan, and command log. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirmPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirmPending}
              onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                event.preventDefault();
                void handleConfirmAction();
              }}
            >
              {pendingConfirmAction?.kind === "archive" ? "Archive conversation" : "Clear thread"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Control local UI behavior without leaving the shell.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <SettingsRow
              title="Auto-scroll to latest"
              description="When you open or switch a conversation, scroll activity panes to the newest content."
              enabled={settings.autoScrollToLatest}
              onToggle={() =>
                setSettings((current) => ({
                  ...current,
                  autoScrollToLatest: !current.autoScrollToLatest
                }))
              }
            />
            <Card className="border bg-muted/20">
              <CardContent className="grid gap-2 p-4 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Signed in</span>
                  <span className="font-medium">{session.username}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Providers</span>
                  <span className="font-medium">{providers.length || 1}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
            <DialogDescription>Give the current thread a durable manual title.</DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={handleRenameSubmit}>
            <div className="grid gap-2">
              <Label htmlFor="rename-conversation">Title</Label>
              <Input
                id="rename-conversation"
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                maxLength={120}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenameOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!renameDraft.trim()}>
                Save title
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <div className="mx-auto flex min-h-screen max-w-[1760px] flex-col gap-3 p-3 sm:p-4 lg:p-5">
        <header className="sticky top-0 z-20 rounded-2xl border bg-background/95 px-4 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border bg-primary/10 text-primary">
                <Workflow className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-base font-semibold tracking-tight">neoshell control plane</h1>
                  <Badge variant="secondary" className="rounded-full px-2 py-0.5">
                    Browser-first PowerShell agent
                  </Badge>
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  Signed in as {session.username} | session expires {formatAbsoluteTime(session.expiresAt)}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2 xl:items-end">
              <div className="flex flex-wrap items-center gap-2">
                {modeTabs}
                <ProviderSelect
                  providers={providers}
                  selectedProviderId={selectedProviderId}
                  onSelectProvider={onSelectProvider}
                />
                <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
                  <Settings2 className="mr-2 h-4 w-4" />
                  Settings
                </Button>
                <Button size="sm" variant="outline" onClick={() => void onNewConversation()}>
                  <Plus className="mr-2 h-4 w-4" />
                  New conversation
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPendingConfirmAction({ kind: "clear" })}
                  disabled={!selectedConversationId}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Clear thread
                </Button>
                <Avatar className="h-9 w-9 border bg-background">
                  <AvatarFallback className="bg-primary/10 text-primary">{initials(session.username)}</AvatarFallback>
                </Avatar>
                <Button size="sm" variant="ghost" onClick={() => void onLogout()}>
                  Logout
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <StatusBadge label="Turn" value={turnStatusLabel(runtime.turnState)} />
                <StatusBadge label="SSE" value={streamStatusLabel(runtime.streamState)} />
                <StatusBadge label="Last event" value={formatRelativeTime(runtime.lastEventAt)} />
                <StatusBadge label="Provider" value={selectedProviderLabel} />
                {isBusy ? (
                  <Badge variant="outline" className="rounded-full">
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    Updating
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>
        </header>

        {globalError ? (
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
              <Badge variant="destructive" className="rounded-full">
                Error
              </Badge>
              <span>{globalError}</span>
            </CardContent>
          </Card>
        ) : null}

        <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[300px_minmax(0,1fr)_360px]">
          <ConversationRail
            conversations={activeConversations}
            archivedConversations={archivedConversations}
            selectedConversationId={selectedConversationId}
            onSelectConversation={onSelectConversation}
            activeConversationButtonRef={activeConversationButtonRef}
          />

          <main className="min-h-0 space-y-3">
            <ConversationSnapshotCard
              conversation={currentConversation}
              runtime={runtime}
              mode={mode}
              selectedProviderLabel={selectedProviderLabel}
              onRenameConversation={() => setRenameOpen(true)}
              onSetConversationArchived={(archived) =>
                archived
                  ? setPendingConfirmAction({ kind: "archive" })
                  : currentConversation
                    ? onSetConversationArchived(currentConversation.id, false)
                    : undefined
              }
            />

            {mode === "agent" ? (
              <AgentWorkspace
                conversationId={selectedConversationId}
                state={state}
                scrollAreaRef={conversationScrollRef}
                events={state.events}
                onSendAgentMessage={onSendAgentMessage}
              />
            ) : (
              <TerminalWorkspace
                conversationId={selectedConversationId}
                state={state}
                terminalCommand={terminalCommand}
                terminalCwd={terminalCwd}
                scrollAreaRef={conversationScrollRef}
                events={state.events}
                onTerminalCommandChange={setTerminalCommand}
                onTerminalCwdChange={setTerminalCwd}
                onExecuteTerminal={onExecuteTerminal}
              />
            )}
          </main>

          <aside className="min-h-0 space-y-3">
            <ObservabilityPanel
              runtime={runtime}
              events={liveEvents}
              error={runtime.lastError}
              scrollAreaRef={observabilityScrollRef}
            />
            <CommandLog commands={state.commands} scrollAreaRef={commandLogScrollRef} />
          </aside>
        </div>
      </div>
    </main>
  );
}

function SettingsRow({
  title,
  description,
  enabled,
  onToggle
}: {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Card className="border bg-muted/20">
      <CardContent className="flex items-center justify-between gap-4 p-4">
        <div className="grid gap-1">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-sm text-muted-foreground">{description}</div>
        </div>
        <Button
          type="button"
          variant={enabled ? "secondary" : "outline"}
          aria-label={`Toggle ${title}`}
          aria-pressed={enabled}
          onClick={onToggle}
        >
          {enabled ? "On" : "Off"}
        </Button>
      </CardContent>
    </Card>
  );
}

function ConversationRail({
  conversations,
  archivedConversations,
  selectedConversationId,
  onSelectConversation,
  activeConversationButtonRef
}: {
  conversations: Conversation[];
  archivedConversations: Conversation[];
  selectedConversationId: string;
  onSelectConversation: (conversationId: string) => void;
  activeConversationButtonRef: React.MutableRefObject<HTMLButtonElement | null>;
}) {
  return (
    <Card className="min-h-0 overflow-hidden border bg-card shadow-sm">
      <CardHeader className="space-y-2 border-b bg-muted/20 px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Threads</CardTitle>
            <CardDescription>Active and archived conversation control plane.</CardDescription>
          </div>
          <Badge variant="outline" className="rounded-full">
            {conversations.length + archivedConversations.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 p-2">
        <ScrollArea className="h-[calc(100vh-15rem)] pr-2">
          <div className="grid gap-4 p-1">
            <ConversationSection
              title="Active"
              conversations={conversations}
              selectedConversationId={selectedConversationId}
              onSelectConversation={onSelectConversation}
              activeConversationButtonRef={activeConversationButtonRef}
            />
            {archivedConversations.length > 0 ? (
              <ConversationSection
                title="Archived"
                conversations={archivedConversations}
                selectedConversationId={selectedConversationId}
                onSelectConversation={onSelectConversation}
                activeConversationButtonRef={activeConversationButtonRef}
              />
            ) : null}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function ConversationSection({
  title,
  conversations,
  selectedConversationId,
  onSelectConversation,
  activeConversationButtonRef
}: {
  title: string;
  conversations: Conversation[];
  selectedConversationId: string;
  onSelectConversation: (conversationId: string) => void;
  activeConversationButtonRef: React.MutableRefObject<HTMLButtonElement | null>;
}) {
  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between gap-2 px-2">
        <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{title}</span>
        <Badge variant="outline" className="rounded-full text-[11px]">
          {conversations.length}
        </Badge>
      </div>
      <div className="grid gap-2">
        {conversations.length === 0 ? (
          <EmptySurface label={`No ${title.toLowerCase()} conversations`} description="Create or restore a thread to continue." />
        ) : (
          conversations.map((conversation) => {
            const selected = conversation.id === selectedConversationId;
            return (
              <Button
                key={conversation.id}
                ref={selected ? activeConversationButtonRef : undefined}
                variant={selected ? "secondary" : "ghost"}
                className={cn(
                  "h-auto w-full justify-start rounded-xl border px-3 py-3 text-left",
                  selected ? "border-primary/30 bg-primary/10" : "border-border/70 bg-card"
                )}
                onClick={() => onSelectConversation(conversation.id)}
              >
                <div className="grid w-full gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{conversation.title}</span>
                    <div className="flex items-center gap-1">
                      {conversation.archivedAt ? (
                        <Badge variant="outline" className="rounded-full text-[11px]">
                          Archived
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>{selected ? "Selected" : `Updated ${formatRelativeTime(conversation.updatedAt)}`}</span>
                    <div className="flex items-center gap-1">
                      {conversation.titleSource === "auto" ? (
                        <Badge variant="outline" className="rounded-full text-[11px]">
                          Auto
                        </Badge>
                      ) : null}
                      {conversation.titleSource === "manual" ? (
                        <Badge variant="outline" className="rounded-full text-[11px]">
                          Manual
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </div>
              </Button>
            );
          })
        )}
      </div>
    </section>
  );
}

function ConversationSnapshotCard({
  conversation,
  runtime,
  mode,
  selectedProviderLabel,
  onRenameConversation,
  onSetConversationArchived
}: {
  conversation: Conversation | null;
  runtime: ConversationRuntime;
  mode: ShellMode;
  selectedProviderLabel: string;
  onRenameConversation: () => void;
  onSetConversationArchived: (archived: boolean) => void;
}) {
  return (
    <Card className="border bg-card shadow-sm">
      <CardContent className="grid gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="rounded-full">
              {mode === "agent" ? "Agent mode" : "Terminal mode"}
            </Badge>
            <Badge variant="outline" className="rounded-full">
              Provider {selectedProviderLabel}
            </Badge>
            <Badge
              variant={runtime.turnState === "failed" ? "destructive" : "outline"}
              className="rounded-full"
            >
              {turnStatusLabel(runtime.turnState)}
            </Badge>
            <Badge variant="outline" className="rounded-full">
              {streamStatusLabel(runtime.streamState)}
            </Badge>
            {conversation?.titleSource === "auto" ? (
              <Badge variant="outline" className="rounded-full">
                Auto title
              </Badge>
            ) : null}
          </div>
          {conversation ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={onRenameConversation}>
                <PencilLine className="mr-2 h-4 w-4" />
                Rename
              </Button>
              <Button
                size="sm"
                variant={conversation.archivedAt ? "outline" : "secondary"}
                onClick={() => onSetConversationArchived(!conversation.archivedAt)}
              >
                {conversation.archivedAt ? (
                  <>
                    <ArchiveRestore className="mr-2 h-4 w-4" />
                    Restore
                  </>
                ) : (
                  <>
                    <Archive className="mr-2 h-4 w-4" />
                    Archive
                  </>
                )}
              </Button>
            </div>
          ) : null}
        </div>
        <div className="grid gap-1">
          <div className="text-sm font-medium tracking-tight">
            {conversation?.title ?? "No conversation selected"}
          </div>
          <div className="text-sm text-muted-foreground">
            Last event {formatRelativeTime(runtime.lastEventAt)} | {runtime.lastEventLabel}
          </div>
        </div>
        {runtime.currentCwd ? (
          <div className="text-xs text-muted-foreground">
            Current cwd <span className="font-medium text-foreground">{runtime.currentCwd}</span>
          </div>
        ) : null}
        {runtime.lastError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {runtime.lastError}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AgentWorkspace({
  conversationId,
  state,
  events,
  scrollAreaRef,
  onSendAgentMessage
}: {
  conversationId: string;
  state: ConversationSurfaceState;
  events: AgentEvent[];
  scrollAreaRef: React.MutableRefObject<HTMLDivElement | null>;
  onSendAgentMessage: (conversationId: string, content: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState("Inspect the current workspace and queue the safest next step.");
  const formRef = useRef<HTMLFormElement | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) return;
    const content = draft.trim();
    setDraft("");
    await onSendAgentMessage(conversationId, content);
  }

  function handleDraftKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  return (
    <div className="grid min-h-0 gap-3">
      <PlanSurface plan={state.plan} />
      <ConversationSurface
        messages={state.messages}
        events={events}
        runtime={state.runtime}
        scrollAreaRef={scrollAreaRef}
      />
      <Card className="border bg-card shadow-sm">
        <CardHeader className="space-y-1.5 px-4 py-4">
          <CardTitle className="text-sm font-semibold">Queue agent turn</CardTitle>
          <CardDescription>Enter sends the turn. Use Shift+Enter for a newline.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-4 pb-4">
          <form ref={formRef} className="grid gap-3" onSubmit={handleSubmit}>
            <Textarea
              className="min-h-[112px] resize-none"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleDraftKeyDown}
              placeholder="Ask the agent to inspect, plan, and execute."
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit">
                <Send className="mr-2 h-4 w-4" />
                Queue turn
              </Button>
              <Badge variant="outline" className="rounded-full">
                Live SSE updates
              </Badge>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function TerminalWorkspace({
  conversationId,
  state,
  events,
  terminalCommand,
  terminalCwd,
  scrollAreaRef,
  onTerminalCommandChange,
  onTerminalCwdChange,
  onExecuteTerminal
}: {
  conversationId: string;
  state: ConversationSurfaceState;
  events: AgentEvent[];
  terminalCommand: string;
  terminalCwd: string;
  scrollAreaRef: React.MutableRefObject<HTMLDivElement | null>;
  onTerminalCommandChange: (value: string) => void;
  onTerminalCwdChange: (value: string) => void;
  onExecuteTerminal: (conversationId: string, command: string, cwd: string) => Promise<void> | void;
}) {
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!terminalCommand.trim()) return;
    await onExecuteTerminal(conversationId, terminalCommand.trim(), terminalCwd.trim() || ".");
  }

  return (
    <div className="grid min-h-0 gap-3">
      <Card className="border bg-card shadow-sm">
        <CardHeader className="space-y-1.5 px-4 py-4">
          <CardTitle className="text-sm font-semibold">PowerShell terminal</CardTitle>
          <CardDescription>
            Manual command execution stays inside the same control plane and shares the event feed.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-4 pb-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className="rounded-full">
              cwd {state.runtime.currentCwd ?? terminalCwd}
            </Badge>
            <Badge
              variant={state.runtime.turnState === "failed" ? "destructive" : "secondary"}
              className="rounded-full"
            >
              {turnStatusLabel(state.runtime.turnState)}
            </Badge>
            <Badge variant="outline" className="rounded-full">
              {streamStatusLabel(state.runtime.streamState)}
            </Badge>
          </div>
          <form className="grid gap-3" onSubmit={handleSubmit}>
            <div className="grid gap-2">
              <Label htmlFor="terminal-cwd">Working directory</Label>
              <Input id="terminal-cwd" value={terminalCwd} onChange={(event) => onTerminalCwdChange(event.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="terminal-command">Command</Label>
              <Textarea
                id="terminal-command"
                className="min-h-[140px] resize-none font-mono text-sm"
                value={terminalCommand}
                onChange={(event) => onTerminalCommandChange(event.target.value)}
                placeholder="Get-ChildItem"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit">
                <Terminal className="mr-2 h-4 w-4" />
                Execute
              </Button>
              <Badge variant="outline" className="rounded-full">
                SSE-backed status
              </Badge>
            </div>
          </form>
        </CardContent>
      </Card>

      <ConversationSurface
        messages={state.messages}
        events={events}
        runtime={state.runtime}
        scrollAreaRef={scrollAreaRef}
      />
    </div>
  );
}

function ConversationSurface({
  messages,
  events,
  runtime,
  scrollAreaRef
}: {
  messages: Message[];
  events: AgentEvent[];
  runtime: ConversationRuntime;
  scrollAreaRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const userMessageTurnStatuses = buildUserMessageTurnStatusMap(messages, events, runtime);

  return (
    <Card className="flex min-h-0 flex-1 flex-col border bg-card shadow-sm">
      <CardHeader className="space-y-1.5 px-4 py-4">
        <CardTitle className="text-sm font-semibold">Conversation stream</CardTitle>
        <CardDescription>Messages, assistant draft output, and live turn state.</CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 px-4 pb-4">
        <ScrollArea ref={scrollAreaRef} className="h-[28rem] pr-3">
          <div className="grid gap-2">
            {messages.length === 0 ? (
              <EmptySurface label="No messages yet" description="Send a turn to see live events and assistant output." />
            ) : (
              messages.map((message) => (
                <MessageRow key={message.id} message={message} turnStatus={userMessageTurnStatuses[message.id]} />
              ))
            )}

            {runtime.turnState !== "completed" && runtime.draftAssistant ? (
              <article className="max-w-[74ch] rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
                <div className="mb-1 flex items-center gap-2">
                  <Badge variant="secondary" className="rounded-full text-[11px] uppercase tracking-wide">
                    Streaming
                  </Badge>
                  <span className="text-xs text-muted-foreground">Live assistant delta</span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6">{runtime.draftAssistant}</p>
              </article>
            ) : null}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function PlanSurface({ plan }: { plan: { id: string; title: string; status: string }[] }) {
  return (
    <Card className="border bg-card shadow-sm">
      <CardHeader className="space-y-1.5 px-4 py-4">
        <CardTitle className="text-sm font-semibold">Plan surface</CardTitle>
        <CardDescription>Structured steps update live as SSE events arrive.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 px-4 pb-4">
        {plan.length === 0 ? (
          <EmptySurface label="No plan yet" description="Ask the agent to plan before it executes." />
        ) : (
          plan.map((step, index) => (
            <div
              key={step.id}
              className="flex items-start justify-between gap-3 rounded-xl border bg-muted/30 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {index + 1}. {step.title}
                </div>
                <div className="text-xs text-muted-foreground">Step id {step.id}</div>
              </div>
              <Badge variant={planBadgeVariant(step.status)} className="rounded-full capitalize">
                {step.status.replaceAll("_", " ")}
              </Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function ObservabilityPanel({
  runtime,
  events,
  error,
  scrollAreaRef
}: {
  runtime: ConversationRuntime;
  events: AgentEvent[];
  error: string | null;
  scrollAreaRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  return (
    <Card className="border bg-card shadow-sm">
      <CardHeader className="space-y-1.5 px-4 py-4">
        <CardTitle className="text-sm font-semibold">Observability</CardTitle>
        <CardDescription>Connection state, last event, and live event log.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 px-4 pb-4">
        <div className="grid gap-2 rounded-xl border bg-muted/25 p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Turn</span>
            <Badge variant={runtime.turnState === "failed" ? "destructive" : "secondary"} className="rounded-full">
              {turnStatusLabel(runtime.turnState)}
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">SSE</span>
            <Badge variant="outline" className="rounded-full">
              {streamStatusLabel(runtime.streamState)}
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Last event</span>
            <span className="font-medium">{formatRelativeTime(runtime.lastEventAt)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Active run</span>
            <span className="font-medium">{runtime.activeRunId ?? "none"}</span>
          </div>
        </div>

        {error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <Separator />

        <ScrollArea ref={scrollAreaRef} className="h-[18rem] pr-3">
          <div className="grid gap-2">
            {events.length === 0 ? (
              <EmptySurface label="No live events yet" description="The next SSE event will appear here immediately." />
            ) : (
              events.map((event, index) => (
                <div key={`${event.type}-${event.at}-${index}`} className="rounded-xl border bg-muted/20 px-3 py-2">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" className="rounded-full text-[11px] uppercase">
                      {event.channel}
                    </Badge>
                    <Badge
                      variant={event.type === "run_failed" ? "destructive" : "outline"}
                      className="rounded-full text-[11px] uppercase"
                    >
                      {event.type.replaceAll("_", " ")}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{formatAbsoluteTime(event.at)}</span>
                  </div>
                  <p className="text-sm leading-6 text-foreground">{eventSummary(event)}</p>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function CommandLog({
  commands,
  scrollAreaRef
}: {
  commands: CommandExecution[];
  scrollAreaRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  return (
    <Card className="border bg-card shadow-sm">
      <CardHeader className="space-y-1.5 px-4 py-4">
        <CardTitle className="text-sm font-semibold">Command log</CardTitle>
        <CardDescription>Execution details remain visible after each turn.</CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <ScrollArea ref={scrollAreaRef} className="h-[18rem] pr-3">
          <div className="grid gap-2">
            {commands.length === 0 ? (
              <EmptySurface label="No commands yet" description="Command execution will appear here live." />
            ) : (
              commands.map((command) => (
                <div
                  key={command.id}
                  className={cn(
                    "grid gap-2 rounded-xl border px-3 py-3",
                    command.exitCode === 0 ? "bg-muted/20" : "border-destructive/30 bg-destructive/5"
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={command.exitCode === 0 ? "secondary" : "destructive"} className="rounded-full">
                      exit {command.exitCode}
                    </Badge>
                    <Badge variant="outline" className="rounded-full">
                      {command.durationMs} ms
                    </Badge>
                    <Badge variant="outline" className="rounded-full">
                      {command.truncated ? "truncated" : "complete"}
                    </Badge>
                  </div>
                  <div className="grid gap-1">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{command.cwd}</div>
                    {command.currentCwd ? (
                      <div className="text-[11px] text-muted-foreground">Current cwd {command.currentCwd}</div>
                    ) : null}
                    <code className="rounded-lg border bg-background px-2 py-1 font-mono text-xs">{command.command}</code>
                  </div>
                  <pre className="overflow-auto whitespace-pre-wrap rounded-lg border bg-background px-2 py-2 font-mono text-[11px] leading-5">
                    {command.outputPreview}
                  </pre>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function MessageRow({ message, turnStatus }: { message: Message; turnStatus?: MessageTurnStatus }) {
  const isUser = message.role === "user";

  return (
    <article
      className={cn(
        "max-w-[76ch] rounded-xl border px-3 py-2",
        isUser ? "ml-auto border-primary/20 bg-primary/5" : "border-border bg-muted/20",
        isUser && turnStatus === "failed" ? "border-destructive/40 bg-destructive/5" : ""
      )}
    >
      <div className="mb-1 flex items-center gap-2">
        <Badge variant={isUser ? "secondary" : "outline"} className="rounded-full text-[11px] uppercase tracking-wide">
          {message.role}
        </Badge>
        {isUser && turnStatus ? (
          <Badge variant={messageTurnStatusVariant(turnStatus)} className="rounded-full text-[11px] uppercase tracking-wide">
            {turnStatus}
          </Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">{formatAbsoluteTime(message.createdAt)}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>
    </article>
  );
}

function ProviderSelect({
  providers,
  selectedProviderId,
  onSelectProvider
}: {
  providers: ProviderConfig[];
  selectedProviderId: string;
  onSelectProvider: (providerId: string) => void;
}) {
  const selectedLabel = providers.find((provider) => provider.providerId === selectedProviderId)?.label ?? "default";

  return (
    <Select value={selectedProviderId} onValueChange={onSelectProvider}>
      <SelectTrigger className="h-9 w-[220px] rounded-full border bg-background">
        <SelectValue placeholder={selectedLabel} />
      </SelectTrigger>
      <SelectContent>
        {providers.length === 0 ? (
          <SelectItem value={selectedProviderId}>default</SelectItem>
        ) : (
          providers.map((provider) => (
            <SelectItem key={provider.providerId} value={provider.providerId}>
              {provider.label}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}

function EmptySurface({ label, description }: { label: string; description: string }) {
  return (
    <div className="rounded-xl border border-dashed bg-muted/20 px-3 py-4 text-sm">
      <div className="font-medium">{label}</div>
      <div className="mt-1 text-muted-foreground">{description}</div>
    </div>
  );
}

function StatusBadge({ label, value }: { label: string; value: string }) {
  return (
    <Badge variant="outline" className="rounded-full">
      <span className="text-muted-foreground">{label}:</span>
      <span className="ml-1">{value}</span>
    </Badge>
  );
}

function messageTurnStatusVariant(status: MessageTurnStatus): "secondary" | "outline" | "destructive" {
  switch (status) {
    case "failed":
      return "destructive";
    case "running":
      return "secondary";
    default:
      return "outline";
  }
}

function planBadgeVariant(status: string): "default" | "secondary" | "outline" | "destructive" {
  switch (status.toLowerCase()) {
    case "completed":
    case "done":
      return "secondary";
    case "blocked":
    case "failed":
      return "destructive";
    case "in_progress":
    case "active":
      return "default";
    default:
      return "outline";
  }
}

function eventSummary(event: AgentEvent) {
  switch (event.type) {
    case "run_started":
      return `Run ${event.runId} started.`;
    case "plan_updated":
      return event.steps.map((step) => step.title).join(" | ");
    case "thinking":
      return event.text;
    case "message_delta":
      return event.text;
    case "command_started":
      return `${event.command} @ ${event.cwd}`;
    case "command_completed":
      return `${event.execution.command} exited ${event.execution.exitCode} in ${event.execution.durationMs} ms`;
    case "assistant_message":
      return event.message.content;
    case "run_completed":
      return `Run ${event.runId} completed.`;
    case "run_failed":
      return event.error;
    default:
      return "Event";
  }
}
