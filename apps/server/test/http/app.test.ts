import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentDecision } from "@neoshell/shared";

import { buildApp } from "../../src/app";

const TEST_WORKSPACE_ROOT = "C:\\workspace\\neoshell";
const TEST_SPILL_DIRECTORY = `${TEST_WORKSPACE_ROOT}\\data\\spill`;
const TEST_PROVIDER = {
  providerId: "default",
  label: "Example Provider",
  kind: "openai_compatible",
  baseUrl: "https://api.example.com/v1",
  model: "provider/chat-model",
  supportsReasoning: true
} as const;

async function waitFor<T>(callback: () => Promise<T>, predicate: (value: T) => boolean, attempts = 50) {
  let lastValue: T | undefined;

  for (let index = 0; index < attempts; index += 1) {
    const value = await callback();
    lastValue = value;
    if (predicate(value)) {
      return value;
    }
    await delay(20);
  }

  throw new Error(`Condition was not met in time. Last value: ${JSON.stringify(lastValue)}`);
}

describe("buildApp", () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("authenticates, creates a conversation, and runs an agent turn asynchronously", async () => {
    const decisions: AgentDecision[] = [
      {
        reasoning: "Inspect the repository first",
        plan: [{ id: "check", title: "Check git status", status: "in_progress" }],
        action: {
          type: "run_command",
          command: "git status --short --branch",
          cwd: "."
        }
      },
      {
        reasoning: "Enough context collected",
        plan: [{ id: "check", title: "Check git status", status: "completed" }],
        action: {
          type: "final_answer",
          message: "Repository is clean."
        }
      }
    ];

    const app = await buildApp({
      config: {
        adminUsername: "admin",
        adminPassword: "password1234",
        databasePath: ":memory:",
        workspaceRoot: TEST_WORKSPACE_ROOT,
        spillDirectory: TEST_SPILL_DIRECTORY,
        sessionCookieName: "neoshell_session",
        secureCookies: false,
        providers: [TEST_PROVIDER]
      },
      runtimeOverrides: {
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
          async run(command, cwd) {
            return {
              command,
              cwd,
              currentCwd: cwd === "." ? TEST_WORKSPACE_ROOT : cwd,
              exitCode: 0,
              truncated: false,
              outputPreview: "## codex/bootstrap-neoshell",
              durationMs: 12
            };
          }
        }
      }
    });
    apps.push(app);

    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/auth/session"
    });
    expect(unauthorized.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "password1234"
      }
    });

    expect(login.statusCode).toBe(200);
    const cookie = login.cookies[0];
    expect(cookie?.name).toBe("neoshell_session");

    const createConversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        title: "Workspace check"
      }
    });

    expect(createConversation.statusCode).toBe(201);
    const conversation = createConversation.json();
    expect(conversation.title).toBe("Workspace check");

    const sendMessage = await app.inject({
      method: "POST",
      url: "/api/messages",
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        conversationId: conversation.id,
        content: "Check the workspace state and summarize it.",
        providerId: "default"
      }
    });

    expect(sendMessage.statusCode).toBe(202);
    const run = sendMessage.json();
    expect(run.accepted).toBe(true);
    expect(run.message.role).toBe("user");
    expect(run.runId).toBeTruthy();

    const getConversation = await waitFor(
      async () =>
        app.inject({
          method: "GET",
          url: `/api/conversations/${conversation.id}`,
          cookies: {
            neoshell_session: cookie?.value ?? ""
          }
        }),
      (response) => {
        const detail = response.json();
        return detail.messages.length === 2 && detail.events.some((event: { type: string }) => event.type === "run_completed");
      }
    );

    expect(getConversation.statusCode).toBe(200);
    const detail = getConversation.json();
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0].role).toBe("user");
    expect(detail.messages[1].role).toBe("assistant");
    expect(
      detail.events.some(
        (event: { type: string; channel?: string }) => event.type === "run_queued" && event.channel === "agent"
      )
    ).toBe(true);
  });

  it("queues terminal execution, records terminal events, and resets the conversation", async () => {
    const app = await buildApp({
      config: {
        adminUsername: "admin",
        adminPassword: "password1234",
        databasePath: ":memory:",
        workspaceRoot: TEST_WORKSPACE_ROOT,
        spillDirectory: TEST_SPILL_DIRECTORY,
        sessionCookieName: "neoshell_session",
        secureCookies: false,
        providers: [TEST_PROVIDER]
      },
      runtimeOverrides: {
        shell: {
          async run(command, cwd) {
            return {
              command,
              cwd,
              currentCwd: cwd === "." ? TEST_WORKSPACE_ROOT : cwd,
              exitCode: 0,
              truncated: false,
              outputPreview: "terminal ok",
              durationMs: 7
            };
          }
        }
      }
    });
    apps.push(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "password1234"
      }
    });
    const cookie = login.cookies[0];

    const createConversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        title: "Terminal mode"
      }
    });
    const conversation = createConversation.json();

    const execute = await app.inject({
      method: "POST",
      url: "/api/terminal/execute",
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        conversationId: conversation.id,
        command: "Get-Location"
      }
    });

    expect(execute.statusCode).toBe(202);
    expect(execute.json().channel).toBe("terminal");

    const getConversation = await waitFor(
      async () =>
        app.inject({
          method: "GET",
          url: `/api/conversations/${conversation.id}`,
          cookies: {
            neoshell_session: cookie?.value ?? ""
          }
        }),
      (response) => {
        const detail = response.json();
        return detail.events.some(
          (event: { type: string; channel?: string }) => event.type === "run_completed" && event.channel === "terminal"
        );
      }
    );

    const detail = getConversation.json();
    expect(
      detail.events.some(
        (event: { type: string; channel?: string }) =>
          event.type === "command_completed" && event.channel === "terminal"
      )
    ).toBe(true);

    const reset = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/reset`,
      cookies: {
        neoshell_session: cookie?.value ?? ""
      }
    });

    expect(reset.statusCode).toBe(200);
    expect(reset.json().ok).toBe(true);

    const resetDetail = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
      cookies: {
        neoshell_session: cookie?.value ?? ""
      }
    });

    expect(resetDetail.json().messages).toHaveLength(0);
    expect(resetDetail.json().events).toHaveLength(0);
  });

  it("passes prior conversation messages into later agent turns", async () => {
    const snapshots: Array<{ contents: string[] }> = [];

    const app = await buildApp({
      config: {
        adminUsername: "admin",
        adminPassword: "password1234",
        databasePath: ":memory:",
        workspaceRoot: TEST_WORKSPACE_ROOT,
        spillDirectory: TEST_SPILL_DIRECTORY,
        sessionCookieName: "neoshell_session",
        secureCookies: false,
        providers: [TEST_PROVIDER]
      },
      runtimeOverrides: {
        provider: {
          async decide(params) {
            snapshots.push({
              contents: params.conversationMessages.map((message) => `${message.role}:${message.content}`)
            });
            return {
              reasoning: "Conversation context is available.",
              plan: [{ id: "reply", title: "Reply with context", status: "completed" }],
              action: {
                type: "final_answer",
                message: `Context size: ${params.conversationMessages.length}`
              }
            };
          }
        }
      }
    });
    apps.push(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "password1234"
      }
    });
    const cookie = login.cookies[0];

    const createConversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        title: "History check"
      }
    });
    const conversation = createConversation.json();

    const firstTurn = await app.inject({
      method: "POST",
      url: "/api/messages",
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        conversationId: conversation.id,
        content: "First message",
        providerId: "default"
      }
    });
    expect(firstTurn.statusCode).toBe(202);

    await waitFor(
      async () =>
        app.inject({
          method: "GET",
          url: `/api/conversations/${conversation.id}`,
          cookies: {
            neoshell_session: cookie?.value ?? ""
          }
        }),
      (response) => response.json().messages.length === 2
    );

    const secondTurn = await app.inject({
      method: "POST",
      url: "/api/messages",
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        conversationId: conversation.id,
        content: "Second message",
        providerId: "default"
      }
    });
    expect(secondTurn.statusCode).toBe(202);

    const detailResponse = await waitFor(
      async () =>
        app.inject({
          method: "GET",
          url: `/api/conversations/${conversation.id}`,
          cookies: {
            neoshell_session: cookie?.value ?? ""
          }
        }),
      (response) => response.json().messages.length === 4
    );

    const detail = detailResponse.json();
    expect(detail.messages).toHaveLength(4);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.contents).toEqual(["user:First message"]);
    expect(snapshots[1]?.contents).toEqual([
      "user:First message",
      "assistant:Context size: 1",
      "user:Second message"
    ]);
  });

  it("treats a timed out agent command as a failed command and still completes the run", async () => {
    const app = await buildApp({
      config: {
        adminUsername: "admin",
        adminPassword: "password1234",
        databasePath: ":memory:",
        workspaceRoot: TEST_WORKSPACE_ROOT,
        spillDirectory: TEST_SPILL_DIRECTORY,
        sessionCookieName: "neoshell_session",
        secureCookies: false,
        commandTimeoutMs: 10,
        providers: [TEST_PROVIDER]
      },
      runtimeOverrides: {
        provider: {
          async decide(params) {
            if (params.iteration === 0) {
              return {
                reasoning: "Try the command once.",
                plan: [{ id: "attempt", title: "Attempt the slow command", status: "in_progress" }],
                action: {
                  type: "run_command",
                  command: "Start-Sleep -Seconds 5",
                  cwd: "."
                }
              };
            }

            expect(params.recentExecutions).toHaveLength(1);
            expect(params.recentExecutions[0]?.timedOut).toBe(true);
            expect(params.recentExecutions[0]?.exitCode).toBe(124);
            expect(params.lastObservation).toContain("Timed out: yes");
            expect(params.consecutiveCommandFailures).toBe(1);

            return {
              reasoning: "The command timed out, so stop retrying blindly.",
              plan: [{ id: "attempt", title: "Attempt the slow command", status: "blocked" }],
              action: {
                type: "final_answer",
                message: "The command timed out and the shell was reset."
              }
            };
          }
        },
        shell: {
          async run(command, cwd) {
            await delay(50);
            return {
              command,
              cwd,
              currentCwd: cwd,
              exitCode: 0,
              timedOut: false,
              truncated: false,
              outputPreview: "late success",
              durationMs: 50
            };
          }
        }
      }
    });
    apps.push(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "password1234"
      }
    });
    const cookie = login.cookies[0];

    const createConversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        title: "Timeout recovery"
      }
    });
    const conversation = createConversation.json();

    const sendMessage = await app.inject({
      method: "POST",
      url: "/api/messages",
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        conversationId: conversation.id,
        content: "Run the slow command and tell me what happened.",
        providerId: "default"
      }
    });

    expect(sendMessage.statusCode).toBe(202);

    const conversationDetail = await waitFor(
      async () =>
        app.inject({
          method: "GET",
          url: `/api/conversations/${conversation.id}`,
          cookies: {
            neoshell_session: cookie?.value ?? ""
          }
        }),
      (response) => {
        const detail = response.json();
        return detail.messages.length === 2 && detail.events.some((event: { type: string }) => event.type === "run_completed");
      }
    );

    const detail = conversationDetail.json();
    expect(detail.messages[1].content).toBe("The command timed out and the shell was reset.");
    expect(
      detail.events.some(
        (event: { type: string; execution?: { exitCode: number; timedOut?: boolean } }) =>
          event.type === "command_completed" &&
          event.execution?.exitCode === 124 &&
          event.execution?.timedOut === true
      )
    ).toBe(true);
    expect(detail.events.some((event: { type: string }) => event.type === "run_failed")).toBe(false);
  });

  it("auto-titles a new conversation after the first assistant reply", async () => {
    const app = await buildApp({
      config: {
        adminUsername: "admin",
        adminPassword: "password1234",
        databasePath: ":memory:",
        workspaceRoot: TEST_WORKSPACE_ROOT,
        spillDirectory: TEST_SPILL_DIRECTORY,
        sessionCookieName: "neoshell_session",
        secureCookies: false,
        providers: [TEST_PROVIDER]
      },
      runtimeOverrides: {
        provider: {
          async decide() {
            return {
              reasoning: "Reply directly.",
              plan: [{ id: "reply", title: "Reply directly", status: "completed" }],
              action: {
                type: "final_answer",
                message: "Workspace inspected."
              }
            };
          }
        }
      }
    });
    apps.push(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "password1234"
      }
    });
    const cookie = login.cookies[0];

    const createConversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        title: "New conversation"
      }
    });
    const conversation = createConversation.json();
    expect(conversation.titleSource).toBe("initial");

    const sendMessage = await app.inject({
      method: "POST",
      url: "/api/messages",
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        conversationId: conversation.id,
        content: "Explain the workspace layout",
        providerId: "default"
      }
    });
    expect(sendMessage.statusCode).toBe(202);

    const conversationDetail = await waitFor(
      async () =>
        app.inject({
          method: "GET",
          url: `/api/conversations/${conversation.id}`,
          cookies: {
            neoshell_session: cookie?.value ?? ""
          }
        }),
      (response) => {
        const detail = response.json();
        return detail.messages.length === 2 && detail.conversation.titleSource === "auto";
      }
    );

    const detail = conversationDetail.json();
    expect(detail.conversation.title).toBe("Explain the workspace layout");
    expect(detail.conversation.titleSource).toBe("auto");
  });

  it("supports manual rename and archive flows without losing the manual title", async () => {
    const app = await buildApp({
      config: {
        adminUsername: "admin",
        adminPassword: "password1234",
        databasePath: ":memory:",
        workspaceRoot: TEST_WORKSPACE_ROOT,
        spillDirectory: TEST_SPILL_DIRECTORY,
        sessionCookieName: "neoshell_session",
        secureCookies: false,
        providers: [TEST_PROVIDER]
      },
      runtimeOverrides: {
        provider: {
          async decide() {
            return {
              reasoning: "Reply directly.",
              plan: [{ id: "reply", title: "Reply directly", status: "completed" }],
              action: {
                type: "final_answer",
                message: "Manual title respected."
              }
            };
          }
        }
      }
    });
    apps.push(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "password1234"
      }
    });
    const cookie = login.cookies[0];

    const createConversation = await app.inject({
      method: "POST",
      url: "/api/conversations",
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        title: "New conversation"
      }
    });
    const conversation = createConversation.json();

    const renameResponse = await app.inject({
      method: "PATCH",
      url: `/api/conversations/${conversation.id}`,
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        title: "Pinned title"
      }
    });
    expect(renameResponse.statusCode).toBe(200);
    expect(renameResponse.json().title).toBe("Pinned title");
    expect(renameResponse.json().titleSource).toBe("manual");

    const archiveResponse = await app.inject({
      method: "PATCH",
      url: `/api/conversations/${conversation.id}`,
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        archived: true
      }
    });
    expect(archiveResponse.statusCode).toBe(200);
    expect(archiveResponse.json().archivedAt).toBeTruthy();

    const sendMessage = await app.inject({
      method: "POST",
      url: "/api/messages",
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        conversationId: conversation.id,
        content: "Explain the workspace layout",
        providerId: "default"
      }
    });
    expect(sendMessage.statusCode).toBe(202);

    const conversationDetail = await waitFor(
      async () =>
        app.inject({
          method: "GET",
          url: `/api/conversations/${conversation.id}`,
          cookies: {
            neoshell_session: cookie?.value ?? ""
          }
        }),
      (response) => response.json().messages.length === 2
    );

    const detail = conversationDetail.json();
    expect(detail.conversation.title).toBe("Pinned title");
    expect(detail.conversation.titleSource).toBe("manual");
    expect(detail.conversation.archivedAt).toBeTruthy();

    const restoreResponse = await app.inject({
      method: "PATCH",
      url: `/api/conversations/${conversation.id}`,
      cookies: {
        neoshell_session: cookie?.value ?? ""
      },
      payload: {
        archived: false
      }
    });
    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().archivedAt).toBeNull();
  });

  it("synchronizes the configured admin password with an existing database", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "neoshell-app-"));
    const databasePath = join(tempDir, "neoshell.sqlite");

    try {
      const firstApp = await buildApp({
        config: {
          adminUsername: "admin",
          adminPassword: "old-password-1234",
          databasePath,
          workspaceRoot: TEST_WORKSPACE_ROOT,
          spillDirectory: TEST_SPILL_DIRECTORY,
          sessionCookieName: "neoshell_session",
          secureCookies: false,
          providers: [TEST_PROVIDER]
        }
      });
      apps.push(firstApp);
      await firstApp.close();
      apps.splice(apps.indexOf(firstApp), 1);

      const secondApp = await buildApp({
        config: {
          adminUsername: "admin",
          adminPassword: "new-password-5678",
          databasePath,
          workspaceRoot: TEST_WORKSPACE_ROOT,
          spillDirectory: TEST_SPILL_DIRECTORY,
          sessionCookieName: "neoshell_session",
          secureCookies: false,
          providers: [TEST_PROVIDER]
        }
      });
      apps.push(secondApp);

      const login = await secondApp.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          username: "admin",
          password: "new-password-5678"
        }
      });

      expect(login.statusCode).toBe(200);
      await secondApp.close();
      apps.splice(apps.indexOf(secondApp), 1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
