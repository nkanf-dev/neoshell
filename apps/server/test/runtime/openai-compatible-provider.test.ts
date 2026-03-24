import { describe, expect, it } from "vitest";

import {
  extractReasoningText,
  normalizeOpenAIChatResponse
} from "../../src/runtime/providers/openai-compatible-provider";

describe("normalizeOpenAIChatResponse", () => {
  it("prefers reasoning_content over reasoning", () => {
    expect(
      extractReasoningText({
        reasoning: "fallback",
        reasoning_content: "preferred"
      })
    ).toBe("preferred");
  });

  it("normalizes text and reasoning blocks into internal content", () => {
    const response = normalizeOpenAIChatResponse({
      id: "resp_1",
      model: "kimi",
      created: 123,
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30
      },
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          message: {
            role: "assistant",
            content:
              "{\"reasoning\":\"Inspect git status first\",\"plan\":[],\"action\":{\"type\":\"final_answer\",\"message\":\"done\"}}",
            reasoning_content: "Inspect git status first"
          }
        }
      ]
    });

    expect(response.content[0]).toMatchObject({
      type: "thinking",
      thinking: "Inspect git status first"
    });
    expect(response.content[1]).toMatchObject({
      type: "text"
    });
    expect(response.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30
    });
  });
});

