import { describe, expect, it } from "vitest";

import { parseJsonResponse, safeParseToolArgs } from "../../src/lib/json";

describe("json helpers", () => {
  it("degrades malformed tool args to an empty object", () => {
    expect(safeParseToolArgs("{")).toEqual({});
    expect(safeParseToolArgs("[]")).toEqual({});
    expect(safeParseToolArgs("\"hello\"")).toEqual({});
  });

  it("throws with a contextual preview for invalid full JSON", () => {
    expect(() => parseJsonResponse("{bad", "decision response")).toThrow(/decision response/);
  });
});

