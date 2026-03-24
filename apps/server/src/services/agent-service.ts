import { isAbsolute, relative, resolve } from "node:path";

import { nanoid } from "nanoid";

import type {
  AgentEvent,
  CommandExecution,
  ProviderConfig,
  QueueMessageResponse,
  TerminalCommandResponse
} from "@neoshell/shared";

import { evaluateCommandPolicy } from "../lib/command-policy";
import { KeyedAsyncQueue } from "../lib/keyed-async-queue";
import { runAgentLoop, type AgentLoopProvider, type AgentLoopShell } from "../runtime/agent-loop";
import { truncateCommandOutput } from "../runtime/output-spill";
import { PersistentPowerShellSession } from "../runtime/persistent-powershell-session";
import { OpenAICompatibleProvider } from "../runtime/providers/openai-compatible-provider";
import { buildSystemPrompt } from "../system-prompt";
import { ConversationEventBus } from "../event-bus";
import { SqliteStore } from "../store/sqlite-store";

type AgentServiceOptions = {
  workspaceRoot: string;
  spillDirectory: string;
  providerTimeoutMs: number;
  commandTimeoutMs: number;
  queue: KeyedAsyncQueue;
  eventBus: ConversationEventBus;
  store: SqliteStore;
  providers: ProviderConfig[];
  providerSecrets: Record<string, string>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
  providerOverride?: AgentLoopProvider;
  shellOverride?: AgentLoopShell;
};

const DEFAULT_COMMAND_RULES: Record<string, "allow" | "deny"> = {
  "*": "allow",
  "curl *": "deny",
  "wget *": "deny",
  "Invoke-WebRequest *": "deny",
  "Start-Process *": "deny",
  "Remove-Item *": "deny",
  "del *": "deny",
  "rmdir *": "deny",
  "git reset *": "deny",
  "git clean *": "deny",
  "shutdown *": "deny",
  "Stop-Computer*": "deny",
  "Restart-Computer*": "deny",
  "Format-* *": "deny"
};

const MAX_HISTORY_MESSAGES = 12;
const MAX_EXECUTION_CONTEXT = 8;
const MAX_PROMPT_CONTENT_CHARS = 4_000;

class CommandTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Command timed out after ${timeoutMs}ms`);
    this.name = "CommandTimeoutError";
  }
}

class CommandPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandPolicyError";
  }
}

class CommandWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandWorkspaceError";
  }
}

export class AgentService {
  private readonly shellSessions = new Map<string, PersistentPowerShellSession>();
  private readonly conversationCwds = new Map<string, string>();

  constructor(private readonly options: AgentServiceOptions) {}

  private getProvider(providerId: string): AgentLoopProvider {
    if (this.options.providerOverride) {
      return this.options.providerOverride;
    }

    const provider = this.options.providers.find((entry) => entry.providerId === providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    const apiKey = this.options.providerSecrets[provider.providerId];
    if (!apiKey) {
      throw new Error(`Missing API key for provider: ${provider.providerId}`);
    }

    const client = new OpenAICompatibleProvider(
      {
        ...provider,
        apiKey,
        requestTimeoutMs: this.options.providerTimeoutMs
      },
      fetch
    );

    const systemPrompt = buildSystemPrompt(this.options.workspaceRoot);
    return {
      decide: async (params) =>
        client.decide({
          systemPrompt,
          history: [
            ...params.conversationMessages.slice(-MAX_HISTORY_MESSAGES).map((message) => ({
              role: message.role as "system" | "user" | "assistant",
              content: trimPromptText(message.content)
            })),
            {
              role: "user",
              content: [
                `Conversation ID: ${params.conversationId}`,
                `Current user request: ${params.userMessage}`,
                `Iteration: ${params.iteration}`,
                `Current plan: ${JSON.stringify(params.plan)}`,
                `Consecutive command failures: ${params.consecutiveCommandFailures}`,
                `Last observation: ${params.lastObservation ?? "none"}`,
                "Recent command outcomes:",
                formatExecutionContext(params.recentExecutions)
              ].join("\n")
            }
          ]
        })
    };
  }

  private getWorkspaceRoot() {
    return resolve(this.options.workspaceRoot);
  }

  private isWithinWorkspace(candidatePath: string) {
    const relativePath = relative(this.getWorkspaceRoot(), candidatePath);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  }

  private resolveWorkspaceCwd(cwd?: string) {
    const absoluteCwd = resolve(this.getWorkspaceRoot(), cwd ?? ".");
    if (!this.isWithinWorkspace(absoluteCwd)) {
      throw new CommandWorkspaceError("Command cwd escapes the workspace root");
    }
    return absoluteCwd;
  }

  private toDisplayCwd(absoluteCwd: string) {
    const relativePath = relative(this.getWorkspaceRoot(), absoluteCwd);
    if (relativePath === "") {
      return ".";
    }
    if (!this.isWithinWorkspace(absoluteCwd)) {
      return absoluteCwd;
    }
    return relativePath.replaceAll("\\", "/");
  }

  private getShellSession(conversationId: string) {
    let session = this.shellSessions.get(conversationId);
    if (!session) {
      session = new PersistentPowerShellSession();
      this.shellSessions.set(conversationId, session);
    }
    return session;
  }

  private getConversationCwd(conversationId: string) {
    return this.conversationCwds.get(conversationId) ?? this.getWorkspaceRoot();
  }

  private setConversationCwd(conversationId: string, currentCwd: string) {
    if (this.isWithinWorkspace(currentCwd)) {
      this.conversationCwds.set(conversationId, currentCwd);
      return;
    }
    this.conversationCwds.set(conversationId, this.getWorkspaceRoot());
  }

  private clearConversationRuntime(conversationId: string) {
    this.options.logger.info({ conversationId }, "Clearing conversation runtime");
    this.conversationCwds.delete(conversationId);
    this.shellSessions.get(conversationId)?.dispose();
    this.shellSessions.delete(conversationId);
  }

  private async runCommandWithTimeout<T>(task: () => Promise<T>) {
    return new Promise<T>((resolveTask, rejectTask) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        rejectTask(new CommandTimeoutError(this.options.commandTimeoutMs));
      }, this.options.commandTimeoutMs);
      timer.unref?.();

      task()
        .then((value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolveTask(value);
        })
        .catch((error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          rejectTask(error);
        });
    });
  }

  private async executeShellCommand(params: {
    conversationId: string;
    command: string;
    cwd?: string;
  }): Promise<Omit<CommandExecution, "id">> {
    const startedAt = Date.now();
    const fallbackCwd = params.cwd ?? this.toDisplayCwd(this.getConversationCwd(params.conversationId));

    try {
      const policy = evaluateCommandPolicy(params.command, DEFAULT_COMMAND_RULES);
      if (policy.action === "deny") {
        throw new CommandPolicyError(
          `Command blocked by policy: ${policy.matchedRule ?? "default deny"}`
        );
      }

      const absoluteStartCwd = params.cwd
        ? this.resolveWorkspaceCwd(params.cwd)
        : this.getConversationCwd(params.conversationId);
      const displayCwd = this.toDisplayCwd(absoluteStartCwd);

      if (this.options.shellOverride) {
        const execution = await this.runCommandWithTimeout(() =>
          this.options.shellOverride!.run(params.command, displayCwd)
        );
        this.setConversationCwd(params.conversationId, absoluteStartCwd);
        return {
          ...execution,
          cwd: execution.cwd || displayCwd,
          currentCwd: absoluteStartCwd,
          timedOut: execution.timedOut ?? false
        };
      }

      const raw = await this.runCommandWithTimeout(() =>
        this.getShellSession(params.conversationId).run(params.command, absoluteStartCwd)
      );
      this.setConversationCwd(params.conversationId, raw.currentCwd);
      const truncated = await truncateCommandOutput(raw.output, {
        outputDir: this.options.spillDirectory
      });

      return {
        command: params.command,
        cwd: displayCwd,
        currentCwd: this.getConversationCwd(params.conversationId),
        exitCode: raw.exitCode,
        timedOut: false,
        truncated: truncated.truncated,
        outputPreview: truncated.outputPreview,
        durationMs: Date.now() - startedAt,
        ...(truncated.outputPath ? { outputPath: truncated.outputPath } : {})
      };
    } catch (error) {
      if (error instanceof CommandTimeoutError) {
        this.clearConversationRuntime(params.conversationId);
        return buildFailedExecution({
          command: params.command,
          cwd: fallbackCwd,
          currentCwd: this.toDisplayCwd(this.getConversationCwd(params.conversationId)),
          message: `${error.message}. The PowerShell session was reset so the agent can retry cleanly.`,
          durationMs: Date.now() - startedAt,
          timedOut: true,
          exitCode: 124
        });
      }

      if (!(error instanceof CommandPolicyError) && !(error instanceof CommandWorkspaceError)) {
        this.clearConversationRuntime(params.conversationId);
      }

      return buildFailedExecution({
        command: params.command,
        cwd: fallbackCwd,
        currentCwd: this.toDisplayCwd(this.getConversationCwd(params.conversationId)),
        message: error instanceof Error ? error.message : "Command failed",
        durationMs: Date.now() - startedAt,
        timedOut: false,
        exitCode: 1
      });
    }
  }

  private getAgentShell(conversationId: string): AgentLoopShell {
    return {
      run: async (command, cwd) =>
        this.executeShellCommand({
          conversationId,
          command,
          cwd
        })
    };
  }

  private async publishEvent(conversationId: string, event: AgentEvent) {
    this.options.store.saveEvent(conversationId, event);
    this.options.eventBus.publish(conversationId, event);
    this.logEvent(conversationId, event);
    if (event.type === "assistant_message") {
      this.options.store.saveMessage({
        id: event.message.id,
        conversationId,
        role: "assistant",
        content: event.message.content,
        createdAt: event.message.createdAt
      });
      this.maybeAutoTitleConversation(conversationId);
    }
  }

  private logEvent(conversationId: string, event: AgentEvent) {
    const context = {
      conversationId,
      runId: event.runId,
      channel: event.channel,
      eventType: event.type
    };

    switch (event.type) {
      case "run_queued":
        this.options.logger.info(
          {
            ...context,
            messageId: event.messageId
          },
          "Run queued"
        );
        return;
      case "run_started":
        this.options.logger.info(context, "Run started");
        return;
      case "plan_updated":
        this.options.logger.debug({ ...context, stepCount: event.steps.length }, "Plan updated");
        return;
      case "thinking":
      case "message_delta":
        this.options.logger.debug(context, "Streaming agent event");
        return;
      case "command_started":
        this.options.logger.info(
          {
            ...context,
            commandId: event.id,
            command: event.command,
            cwd: event.cwd
          },
          "Command started"
        );
        return;
      case "command_completed":
        this.options.logger[event.execution.exitCode === 0 ? "info" : "warn"](
          {
            ...context,
            commandId: event.execution.id,
            command: event.execution.command,
            cwd: event.execution.cwd,
            currentCwd: event.execution.currentCwd,
            exitCode: event.execution.exitCode,
            timedOut: event.execution.timedOut ?? false,
            truncated: event.execution.truncated,
            durationMs: event.execution.durationMs
          },
          "Command completed"
        );
        return;
      case "assistant_message":
        this.options.logger.info(
          {
            ...context,
            messageId: event.message.id,
            contentChars: event.message.content.length
          },
          "Assistant message committed"
        );
        return;
      case "run_completed":
        this.options.logger.info(context, "Run completed");
        return;
      case "run_failed":
        this.options.logger.error(
          {
            ...context,
            error: event.error
          },
          "Run failed"
        );
        return;
      default:
        return;
    }
  }

  private maybeAutoTitleConversation(conversationId: string) {
    const conversation = this.options.store.findConversationById(conversationId);
    if (!conversation || conversation.titleSource === "manual" || conversation.titleSource === "auto") {
      return;
    }

    const messages = this.options.store.listMessages(conversationId);
    const suggestedTitle = suggestConversationTitle(messages);
    if (!suggestedTitle) {
      return;
    }

    this.options.store.updateConversation({
      conversationId,
      title: suggestedTitle,
      titleSource: "auto"
    });
    this.options.logger.info({ conversationId, title: suggestedTitle }, "Auto-titled conversation");
  }

  private async failQueuedRun(params: {
    conversationId: string;
    runId: string;
    channel: "agent" | "terminal";
    error: unknown;
  }) {
    await this.publishEvent(params.conversationId, {
      type: "run_failed",
      runId: params.runId,
      at: new Date().toISOString(),
      channel: params.channel,
      error: params.error instanceof Error ? params.error.message : "Unknown queued run error"
    });
  }

  async queueConversationTurn(params: {
    conversationId: string;
    userMessage: string;
    providerId: string;
  }): Promise<QueueMessageResponse> {
    const userMessage = this.options.store.saveMessage({
      conversationId: params.conversationId,
      role: "user",
      content: params.userMessage
    });
    const runId = nanoid();
    const queuedAt = new Date().toISOString();

    this.options.logger.info(
      {
        conversationId: params.conversationId,
        runId,
        providerId: params.providerId,
        userMessageChars: userMessage.content.length
      },
      "Queueing agent conversation turn"
    );

    await this.publishEvent(params.conversationId, {
      type: "run_queued",
      runId,
      at: queuedAt,
      channel: "agent",
      messageId: userMessage.id
    });

    void this.options.queue
      .enqueue(params.conversationId, async () => {
        const conversationMessages = this.options.store.listMessages(params.conversationId);
        const priorExecutions = getRecentExecutions(this.options.store.listEvents(params.conversationId));
        const provider = this.getProvider(params.providerId);
        await runAgentLoop({
          conversationId: params.conversationId,
          userMessage: userMessage.content,
          conversationMessages,
          priorExecutions,
          provider,
          shell: this.getAgentShell(params.conversationId),
          runId,
          channel: "agent",
          onEvent: async (event) => {
            await this.publishEvent(params.conversationId, event);
          }
        });
      })
      .catch((error) =>
        this.failQueuedRun({
          conversationId: params.conversationId,
          runId,
          channel: "agent",
          error
        })
      );

    return {
      accepted: true,
      conversationId: params.conversationId,
      runId,
      queuedAt,
      message: userMessage
    };
  }

  async queueTerminalCommand(params: {
    conversationId: string;
    command: string;
    cwd?: string;
  }): Promise<TerminalCommandResponse> {
    const runId = nanoid();
    const queuedAt = new Date().toISOString();
    const currentCwd = params.cwd
      ? this.resolveWorkspaceCwd(params.cwd)
      : this.getConversationCwd(params.conversationId);

    this.options.logger.info(
      {
        conversationId: params.conversationId,
        runId,
        command: params.command,
        cwd: params.cwd ?? "."
      },
      "Queueing terminal command"
    );

    await this.publishEvent(params.conversationId, {
      type: "run_queued",
      runId,
      at: queuedAt,
      channel: "terminal"
    });

    void this.options.queue
      .enqueue(params.conversationId, async () => {
        const startedAt = new Date().toISOString();
        const commandId = nanoid();
        const displayCwd = this.toDisplayCwd(currentCwd);

        await this.publishEvent(params.conversationId, {
          type: "run_started",
          runId,
          at: startedAt,
          channel: "terminal"
        });
        await this.publishEvent(params.conversationId, {
          type: "command_started",
          runId,
          at: startedAt,
          channel: "terminal",
          id: commandId,
          command: params.command,
          cwd: displayCwd
        });

        try {
          const execution = await this.executeShellCommand({
            conversationId: params.conversationId,
            command: params.command,
            cwd: currentCwd
          });
          await this.publishEvent(params.conversationId, {
            type: "command_completed",
            runId,
            at: new Date().toISOString(),
            channel: "terminal",
            execution: {
              id: commandId,
              ...execution
            }
          });
          await this.publishEvent(params.conversationId, {
            type: "run_completed",
            runId,
            at: new Date().toISOString(),
            channel: "terminal"
          });
        } catch (error) {
          await this.failQueuedRun({
            conversationId: params.conversationId,
            runId,
            channel: "terminal",
            error
          });
        }
      })
      .catch((error) =>
        this.failQueuedRun({
          conversationId: params.conversationId,
          runId,
          channel: "terminal",
          error
        })
      );

    return {
      accepted: true,
      conversationId: params.conversationId,
      runId,
      queuedAt,
      currentCwd,
      channel: "terminal"
    };
  }

  async resetConversation(conversationId: string) {
    return this.options.queue.enqueue(conversationId, async () => {
      this.clearConversationRuntime(conversationId);
      return this.options.store.resetConversation(conversationId);
    });
  }

  async deleteConversation(conversationId: string) {
    return this.options.queue.enqueue(conversationId, async () => {
      this.clearConversationRuntime(conversationId);
      this.options.store.deleteConversation(conversationId);
    });
  }

  dispose(): void {
    for (const session of this.shellSessions.values()) {
      session.dispose();
    }
    this.shellSessions.clear();
    this.conversationCwds.clear();
  }
}

function buildFailedExecution(params: {
  command: string;
  cwd: string;
  currentCwd: string;
  message: string;
  durationMs: number;
  timedOut: boolean;
  exitCode: number;
}): Omit<CommandExecution, "id"> {
  return {
    command: params.command,
    cwd: params.cwd,
    currentCwd: params.currentCwd,
    exitCode: params.exitCode,
    timedOut: params.timedOut,
    truncated: false,
    outputPreview: params.message,
    durationMs: params.durationMs
  };
}

function trimPromptText(content: string) {
  if (content.length <= MAX_PROMPT_CONTENT_CHARS) {
    return content;
  }
  return `${content.slice(0, MAX_PROMPT_CONTENT_CHARS - 14)}\n...[truncated]`;
}

function formatExecutionContext(executions: CommandExecution[]) {
  if (executions.length === 0) {
    return "none";
  }

  return executions
    .slice(-MAX_EXECUTION_CONTEXT)
    .map((execution, index) =>
      [
        `[${index + 1}] ${execution.command}`,
        `cwd=${execution.cwd}`,
        `exit=${execution.exitCode}`,
        `timedOut=${execution.timedOut ? "yes" : "no"}`,
        `output=${trimPromptText(execution.outputPreview || "(no output)")}`
      ].join(" | ")
    )
    .join("\n");
}

function getRecentExecutions(events: AgentEvent[]) {
  return events
    .filter(
      (event): event is Extract<AgentEvent, { type: "command_completed" }> =>
        event.type === "command_completed"
    )
    .map((event) => event.execution)
    .slice(-MAX_EXECUTION_CONTEXT);
}

function suggestConversationTitle(messages: Array<{ role: string; content: string }>) {
  const firstUserMessage = messages.find((message) => message.role === "user")?.content;
  if (!firstUserMessage) {
    return null;
  }

  const normalized = firstUserMessage
    .replace(/[`*_#>\[\]\(\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return null;
  }

  const sentence = normalized.split(/[.!?。！？]/)[0]?.trim() ?? normalized;
  const withoutTrailingColon = sentence.replace(/[:;,\s-]+$/, "").trim();
  const base = withoutTrailingColon || normalized;

  if (base.length <= 48) {
    return base;
  }

  const shortened = base.slice(0, 48);
  const boundary = shortened.lastIndexOf(" ");
  const candidate = (boundary >= 24 ? shortened.slice(0, boundary) : shortened).trim();
  return candidate.replace(/[:;,\s-]+$/, "").trim() || "Conversation";
}
