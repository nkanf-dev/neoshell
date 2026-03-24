export function safeParseToolArgs(jsonString: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(jsonString);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function parseJsonResponse<T>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    throw new Error(`Failed to parse ${context} response as JSON: ${preview}`, {
      cause: cause instanceof Error ? cause : undefined
    });
  }
}

