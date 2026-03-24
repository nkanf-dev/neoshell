import type { AgentDecision, ProviderConfig } from "@neoshell/shared";

import { parseJsonResponse } from "../../lib/json";

export type NormalizedContentBlock =
  | {
      type: "thinking";
      thinking: string;
    }
  | {
      type: "text";
      text: string;
    };

export type NormalizedResponse = {
  id: string;
  model: string;
  content: NormalizedContentBlock[];
  stopReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  createdAt: number;
};

type OpenAIChatResponse = {
  id: string;
  model: string;
  created: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  choices: Array<{
    index: number;
    finish_reason: string | null;
    message: {
      role: string;
      content?: string | null;
      reasoning_content?: string;
      reasoning?: string;
    };
  }>;
};

export function extractReasoningText(payload?: {
  reasoning_content?: string;
  reasoning?: string;
}): string | undefined {
  if (!payload) {
    return undefined;
  }
  if (payload.reasoning_content && payload.reasoning_content.length > 0) {
    return payload.reasoning_content;
  }
  if (payload.reasoning && payload.reasoning.length > 0) {
    return payload.reasoning;
  }
  return undefined;
}

export function normalizeOpenAIChatResponse(resp: OpenAIChatResponse): NormalizedResponse {
  const choice = resp.choices[0];
  const content: NormalizedContentBlock[] = [];

  const reasoningText = extractReasoningText(choice?.message);
  if (reasoningText) {
    content.push({
      type: "thinking",
      thinking: reasoningText
    });
  }

  if (choice?.message.content) {
    content.push({
      type: "text",
      text: choice.message.content
    });
  }

  return {
    id: resp.id,
    model: resp.model,
    content,
    stopReason: choice?.finish_reason ?? null,
    usage: {
      inputTokens: resp.usage?.prompt_tokens ?? -1,
      outputTokens: resp.usage?.completion_tokens ?? -1,
      totalTokens: resp.usage?.total_tokens ?? -1
    },
    createdAt: resp.created
  };
}

export class OpenAICompatibleProvider {
  constructor(
    private readonly config: ProviderConfig & { apiKey: string; requestTimeoutMs?: number },
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async decide(params: {
    systemPrompt: string;
    history: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  }): Promise<AgentDecision> {
    const response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 60_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: params.systemPrompt },
          ...params.history
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Provider request failed with status ${response.status}`);
    }

    const raw = (await response.text()) || "{}";
    const normalized = normalizeOpenAIChatResponse(parseJsonResponse<OpenAIChatResponse>(raw, "provider"));
    const textBlock = normalized.content.find(
      (entry): entry is Extract<NormalizedContentBlock, { type: "text" }> => entry.type === "text"
    );

    if (!textBlock) {
      throw new Error("Provider response did not include a text block");
    }

    return parseJsonResponse<AgentDecision>(textBlock.text, "decision");
  }
}
