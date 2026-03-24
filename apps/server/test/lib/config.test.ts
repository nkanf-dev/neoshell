import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveWorkspaceEnvPath, resolveWorkspaceRoot } from "../../src/config";

describe("resolveWorkspaceEnvPath", () => {
  it("targets the repository root .env file", () => {
    const configModuleUrl = new URL("../../src/config.ts", import.meta.url).href;
    const expected = fileURLToPath(new URL("../../../../.env", import.meta.url));

    expect(resolveWorkspaceEnvPath(configModuleUrl)).toBe(expected);
  });
});

describe("resolveWorkspaceRoot", () => {
  it("targets the repository root directory", () => {
    const configModuleUrl = new URL("../../src/config.ts", import.meta.url).href;
    const expected = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/[\\/]$/, "");

    expect(resolveWorkspaceRoot(configModuleUrl)).toBe(expected);
  });
});
