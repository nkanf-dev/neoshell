import { describe, expect, it } from "vitest";

import { evaluateCommandPolicy } from "../../src/lib/command-policy";

describe("evaluateCommandPolicy", () => {
  it("allows matching read-oriented rules", () => {
    const result = evaluateCommandPolicy("Get-ChildItem -Force", {
      "*": "deny",
      "Get-ChildItem *": "allow",
      "git status *": "allow"
    });

    expect(result.action).toBe("allow");
    expect(result.matchedRule).toBe("Get-ChildItem *");
  });

  it("uses last matching rule wins semantics", () => {
    const result = evaluateCommandPolicy("Remove-Item temp -Recurse -Force", {
      "*": "allow",
      "Remove-Item *": "allow",
      "Remove-Item * -Recurse*": "deny"
    });

    expect(result.action).toBe("deny");
    expect(result.matchedRule).toBe("Remove-Item * -Recurse*");
  });

  it("normalizes slash variants and optional tails", () => {
    const result = evaluateCommandPolicy("Get-Content .\\README.md", {
      "Get-Content *": "allow"
    });

    expect(result.action).toBe("allow");
  });
});

