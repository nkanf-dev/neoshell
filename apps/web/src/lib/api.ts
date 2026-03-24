import {
  agentEventSchema,
  type AgentEvent,
  type AuthSession,
  type Conversation,
  type Message,
  type ProviderConfig,
  type SendMessageInput,
  type UpdateConversationInput
} from "@neoshell/shared";

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
};

export class ApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

function resolveApiUrl(input: RequestInfo | URL) {
  if (typeof input !== "string") {
    return input;
  }

  const configuredBaseUrl = import.meta.env.VITE_NEOSHELL_API_BASE_URL?.trim();
  if (!configuredBaseUrl) {
    return input;
  }

  return new URL(input, configuredBaseUrl).toString();
}

async function requestJson<T>(input: RequestInfo | URL, init: RequestOptions = {}) {
  const hasBody = init.body !== undefined;

  const response = await fetch(resolveApiUrl(input), {
    credentials: "include",
    ...init,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {})
    },
    body: hasBody ? JSON.stringify(init.body) : undefined
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text().catch(() => "");

    if (contentType.includes("text/html")) {
      throw new ApiError(
        "The frontend reached an HTML page instead of the neoshell backend. Check the proxy target or backend origin boundary.",
        response.status,
        body
      );
    }

    let payload: unknown = body;
    let message = body || `Request failed with ${response.status}`;

    if (contentType.includes("application/json") && body) {
      try {
        payload = JSON.parse(body) as unknown;
        if (typeof payload === "object" && payload && "message" in payload) {
          const maybeMessage = (payload as { message?: unknown }).message;
          if (typeof maybeMessage === "string" && maybeMessage.trim()) {
            message = maybeMessage;
          }
        }
      } catch {
        // Keep the text payload when the server sends invalid JSON.
      }
    }

    throw new ApiError(message, response.status, payload);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const authApi = {
  session: () => requestJson<AuthSession | null>("/api/auth/session", { cache: "no-store" }),
  login: (username: string, password: string) =>
    requestJson<AuthSession>("/api/auth/login", {
      method: "POST",
      body: { username, password }
    }),
  logout: () =>
    requestJson<void>("/api/auth/logout", {
      method: "POST"
    })
};

export const providersApi = {
  list: async () =>
    (await requestJson<{ providers: ProviderConfig[] }>("/api/providers", {
      cache: "no-store"
    })).providers
};

export type ConversationSummary = Conversation;

export type ConversationDetail = {
  conversation: ConversationSummary;
  messages: Message[];
  events: AgentEvent[];
};

export type SendMessageResponse = {
  accepted: true;
  conversationId: string;
  runId: string;
  queuedAt: string;
  message: Message;
};

export type TerminalExecuteResponse = {
  accepted: true;
  conversationId: string;
  runId: string;
  queuedAt: string;
  currentCwd: string;
  channel: "terminal";
};

export const conversationApi = {
  list: async () =>
    (await requestJson<{ conversations: ConversationSummary[] }>("/api/conversations", {
      cache: "no-store"
    })).conversations,
  create: (title: string) =>
    requestJson<ConversationSummary>("/api/conversations", {
      method: "POST",
      body: { title }
    }),
  update: (conversationId: string, payload: UpdateConversationInput) =>
    requestJson<ConversationSummary>(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: "PATCH",
      body: payload
    }),
  delete: (conversationId: string) =>
    requestJson<void>(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE"
    }),
  reset: (conversationId: string) =>
    requestJson<{ ok: true; conversation: ConversationSummary }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/reset`,
      {
        method: "POST"
      }
    ),
  get: (conversationId: string) =>
    requestJson<ConversationDetail>(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      cache: "no-store"
    })
};

export const messageApi = {
  list: async (conversationId: string) =>
    (
      await requestJson<{ messages: Message[] }>(
        `/api/messages?conversationId=${encodeURIComponent(conversationId)}`,
        { cache: "no-store" }
      )
    ).messages,
  send: (payload: SendMessageInput) =>
    requestJson<SendMessageResponse>("/api/messages", {
      method: "POST",
      body: payload
    })
};

export type TerminalExecuteInput = {
  conversationId: string;
  command: string;
  cwd?: string;
  providerId?: string;
};

export const terminalApi = {
  execute: (payload: TerminalExecuteInput) =>
    requestJson<TerminalExecuteResponse>("/api/terminal/execute", {
      method: "POST",
      body: payload
    })
};

export async function* streamEvents(conversationId: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  const response = await fetch(
    resolveApiUrl(`/api/events/stream?conversationId=${encodeURIComponent(conversationId)}`),
    {
      signal,
      credentials: "include",
      headers: {
        Accept: "text/event-stream"
      }
    }
  );

  if (!response.ok || !response.body) {
    throw new Error(`Failed to open event stream (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const dataLines = chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());

      if (dataLines.length === 0) continue;

      const raw = dataLines.join("\n");
      const parsed = JSON.parse(raw) as unknown;
      const event = agentEventSchema.parse(parsed);
      yield event;
    }
  }
}
