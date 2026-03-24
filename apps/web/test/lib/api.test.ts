import { afterEach, describe, expect, it, vi } from "vitest";

import { authApi, conversationApi } from "../../src/lib/api";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json"
    },
    ...init
  });
}

describe("api client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits the JSON content-type header for logout requests without a body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }));

    await authApi.logout();

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual({});
  });

  it("omits the JSON content-type header for reset requests without a body", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ok: true, conversation: { id: "c1", title: "T", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }));

    await conversationApi.reset("c1");

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual({});
  });
});
