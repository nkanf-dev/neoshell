import fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

import {
  createConversationInputSchema,
  loginInputSchema,
  sendMessageInputSchema,
  terminalCommandInputSchema,
  updateConversationInputSchema
} from "@neoshell/shared";

import { createSessionToken, hashPassword, hashToken, verifyPassword } from "./auth";
import type { NeoshellConfig } from "./config";
import { loadConfig } from "./config";
import { ConversationEventBus } from "./event-bus";
import { KeyedAsyncQueue } from "./lib/keyed-async-queue";
import type { AgentLoopProvider, AgentLoopShell } from "./runtime/agent-loop";
import { AgentService } from "./services/agent-service";
import { SqliteStore } from "./store/sqlite-store";

type BuildAppOptions = {
  config?: Partial<NeoshellConfig>;
  runtimeOverrides?: {
    provider?: AgentLoopProvider;
    shell?: AgentLoopShell;
  };
};

export async function buildApp(options: BuildAppOptions = {}) {
  const defaults = loadConfig();
  const config: NeoshellConfig = {
    ...defaults,
    ...options.config,
    providers: options.config?.providers ?? defaults.providers,
    providerSecrets: options.config?.providerSecrets ?? defaults.providerSecrets
  };
  const app = fastify({
    logger:
      config.logLevel === "silent"
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: ["req.headers.cookie", "res.headers['set-cookie']"],
              remove: true
            }
          }
  });
  const store = new SqliteStore(config.databasePath);
  store.initialize();
  app.log.info(
    {
      databasePath: config.databasePath,
      workspaceRoot: config.workspaceRoot,
      providerCount: config.providers.length
    },
    "Initialized SQLite store"
  );

  const existingAdmin = store.findUserByUsername(config.adminUsername);
  if (!existingAdmin) {
    store.createUser(config.adminUsername, hashPassword(config.adminPassword));
    app.log.info({ username: config.adminUsername }, "Created admin user from configuration");
  } else if (!verifyPassword(config.adminPassword, existingAdmin.password_hash)) {
    store.updateUserPassword(existingAdmin.id, hashPassword(config.adminPassword));
    app.log.info({ userId: existingAdmin.id, username: config.adminUsername }, "Synchronized admin password from configuration");
  }

  const eventBus = new ConversationEventBus();
  const agentService = new AgentService({
    workspaceRoot: config.workspaceRoot,
    spillDirectory: config.spillDirectory,
    providerTimeoutMs: config.providerTimeoutMs,
    commandTimeoutMs: config.commandTimeoutMs,
    queue: new KeyedAsyncQueue(),
    eventBus,
    store,
    providers: config.providers,
    providerSecrets: config.providerSecrets,
    logger: app.log,
    providerOverride: options.runtimeOverrides?.provider,
    shellOverride: options.runtimeOverrides?.shell
  });

  await app.register(cookie);
  await app.register(helmet);
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute"
  });
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      try {
        const url = new URL(origin);
        const isLoopbackOrigin = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
        const isAllowed = config.allowedOrigins.includes(origin) || (process.env.NODE_ENV !== "production" && isLoopbackOrigin);
        if (!isAllowed) {
          app.log.warn({ origin }, "Rejected request origin");
        }
        callback(null, isAllowed);
        return;
      } catch {
        app.log.warn({ origin }, "Rejected malformed request origin");
        callback(null, false);
      }
    },
    credentials: true
  });

  async function getSessionContext(request: FastifyRequest) {
    const token = request.cookies[config.sessionCookieName];
    if (!token) {
      return undefined;
    }
    const session = store.findSessionByTokenHash(hashToken(token));
    if (!session || new Date(session.expires_at).getTime() < Date.now()) {
      return undefined;
    }
    store.touchSession(session.id);
    const user = store.findUserById(session.user_id);
    if (!user) {
      return undefined;
    }
    return {
      user,
      session
    };
  }

  async function requireUser(request: FastifyRequest, reply: FastifyReply) {
    const context = await getSessionContext(request);
    if (!context) {
      reply.code(401).send({
        error: "Unauthorized"
      });
      return undefined;
    }
    return context.user;
  }

  app.get("/api/health", async () => ({
    ok: true
  }));

  app.get("/api/providers", async () => ({
    providers: config.providers
  }));

  app.get("/api/auth/session", async (request, reply) => {
    const context = await getSessionContext(request);
    if (!context) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    reply.send({
      userId: context.user.id,
      username: context.user.username,
      expiresAt: context.session.expires_at
    });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const input = loginInputSchema.parse(request.body);
    const user = store.findUserByUsername(input.username);
    if (!user || !verifyPassword(input.password, user.password_hash)) {
      request.log.warn({ username: input.username }, "Failed login attempt");
      reply.code(401).send({ error: "Invalid credentials" });
      return;
    }

    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000).toISOString();
    store.createSession(user.id, hashToken(token), expiresAt);
    reply.setCookie(config.sessionCookieName, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: config.secureCookies,
      expires: new Date(expiresAt)
    });
    reply.send({
      userId: user.id,
      username: user.username,
      expiresAt
    });
    request.log.info({ userId: user.id, username: user.username }, "User login succeeded");
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const context = await getSessionContext(request);
    const token = request.cookies[config.sessionCookieName];
    if (token) {
      store.deleteSession(hashToken(token));
    }
    reply.clearCookie(config.sessionCookieName, {
      path: "/"
    });
    reply.send({
      ok: true
    });
    request.log.info(
      {
        userId: context?.user.id,
        username: context?.user.username
      },
      "User logout completed"
    );
  });

  app.get("/api/conversations", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }
    reply.send({
      conversations: store.listConversations(user.id)
    });
  });

  app.post("/api/conversations", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }
    const input = createConversationInputSchema.parse(request.body);
    const conversation = store.createConversation(user.id, input.title);
    request.log.info({ userId: user.id, conversationId: conversation.id, title: conversation.title }, "Created conversation");
    reply.code(201).send(conversation);
  });

  app.patch("/api/conversations/:id", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }
    const params = request.params as { id: string };
    const conversation = store.getConversation(user.id, params.id);
    if (!conversation) {
      reply.code(404).send({
        error: "Conversation not found"
      });
      return;
    }

    const input = updateConversationInputSchema.parse(request.body);
    const updatedConversation = store.updateConversation({
      conversationId: conversation.id,
      ...(input.title !== undefined ? { title: input.title, titleSource: "manual" } : {}),
      ...(input.archived !== undefined
        ? { archivedAt: input.archived ? new Date().toISOString() : null }
        : {})
    });

    if (!updatedConversation) {
      reply.code(404).send({
        error: "Conversation not found"
      });
      return;
    }

    request.log.info(
      {
        userId: user.id,
        conversationId: conversation.id,
        titleUpdated: input.title !== undefined,
        archivedUpdated: input.archived !== undefined,
        archivedAt: updatedConversation.archivedAt
      },
      "Updated conversation metadata"
    );
    reply.send(updatedConversation);
  });

  app.get("/api/conversations/:id", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }
    const params = request.params as { id: string };
    const conversation = store.getConversation(user.id, params.id);
    if (!conversation) {
      reply.code(404).send({
        error: "Conversation not found"
      });
      return;
    }
    reply.send({
      conversation,
      messages: store.listMessages(conversation.id),
      events: store.listEvents(conversation.id)
    });
  });

  app.post("/api/conversations/:id/reset", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }
    const params = request.params as { id: string };
    const conversation = store.getConversation(user.id, params.id);
    if (!conversation) {
      reply.code(404).send({
        error: "Conversation not found"
      });
      return;
    }
    const resetConversation = await agentService.resetConversation(conversation.id);
    if (!resetConversation) {
      reply.code(404).send({
        error: "Conversation not found"
      });
      return;
    }
    request.log.warn({ userId: user.id, conversationId: conversation.id }, "Cleared conversation history");
    reply.send({
      ok: true,
      conversation: resetConversation
    });
  });

  app.delete("/api/conversations/:id", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }
    const params = request.params as { id: string };
    const conversation = store.getConversation(user.id, params.id);
    if (!conversation) {
      reply.code(404).send({
        error: "Conversation not found"
      });
      return;
    }
    await agentService.deleteConversation(conversation.id);
    request.log.warn({ userId: user.id, conversationId: conversation.id }, "Deleted conversation");
    reply.code(204).send();
  });

  app.post("/api/messages", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }
    const input = sendMessageInputSchema.parse(request.body);
    const conversation = store.getConversation(user.id, input.conversationId);
    if (!conversation) {
      reply.code(404).send({
        error: "Conversation not found"
      });
      return;
    }
    const queued = await agentService.queueConversationTurn({
      conversationId: input.conversationId,
      userMessage: input.content,
      providerId: input.providerId
    });
    request.log.info(
      {
        userId: user.id,
        conversationId: input.conversationId,
        runId: queued.runId,
        providerId: input.providerId,
        messageId: queued.message.id
      },
      "Accepted agent message"
    );
    reply.code(202).send(queued);
  });

  app.get("/api/messages", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }
    const query = request.query as { conversationId?: string };
    if (!query.conversationId) {
      reply.code(400).send({
        error: "conversationId is required"
      });
      return;
    }
    const conversation = store.getConversation(user.id, query.conversationId);
    if (!conversation) {
      reply.code(404).send({
        error: "Conversation not found"
      });
      return;
    }
    reply.send({
      messages: store.listMessages(query.conversationId)
    });
  });

  app.get("/api/events/stream", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }
    const { conversationId } = request.query as { conversationId?: string };
    if (!conversationId) {
      reply.code(400).send({ error: "conversationId is required" });
      return;
    }
    const conversation = store.getConversation(user.id, conversationId);
    if (!conversation) {
      reply.code(404).send({ error: "Conversation not found" });
      return;
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    request.log.info({ userId: user.id, conversationId }, "Opened SSE event stream");

    for (const event of store.listEvents(conversationId)) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const unsubscribe = eventBus.subscribe(conversationId, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      reply.raw.write(": keep-alive\n\n");
    }, 15000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      request.log.info({ userId: user.id, conversationId }, "Closed SSE event stream");
      reply.raw.end();
    });
  });

  app.post("/api/terminal/execute", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }
    const input = terminalCommandInputSchema.parse(request.body);
    const conversation = store.getConversation(user.id, input.conversationId);
    if (!conversation) {
      reply.code(404).send({
        error: "Conversation not found"
      });
      return;
    }
    const queued = await agentService.queueTerminalCommand({
      conversationId: input.conversationId,
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {})
    });
    request.log.info(
      {
        userId: user.id,
        conversationId: input.conversationId,
        runId: queued.runId,
        cwd: queued.currentCwd
      },
      "Accepted terminal execution"
    );
    reply.code(202).send(queued);
  });

  app.addHook("onClose", async () => {
    app.log.info("Shutting down neoshell server");
    agentService.dispose();
    store.close();
  });

  return app;
}
