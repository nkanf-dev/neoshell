import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { truncateCommandOutput } from "../../src/runtime/output-spill";

describe("truncateCommandOutput", () => {
  it("returns the full output when within limits", async () => {
    const result = await truncateCommandOutput("hello", {
      outputDir: mkdtempSync(join(tmpdir(), "neoshell-output-")),
      maxLines: 10,
      maxBytes: 1024
    });

    expect(result.truncated).toBe(false);
    expect(result.outputPreview).toBe("hello");
    expect(result.outputPath).toBeUndefined();
  });

  it("spills oversized output to disk with a bounded preview", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neoshell-output-"));
    const full = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n");

    const result = await truncateCommandOutput(full, {
      outputDir,
      maxLines: 5,
      maxBytes: 80
    });

    expect(result.truncated).toBe(true);
    expect(result.outputPreview).toContain("truncated");
    expect(result.outputPath).toBeDefined();
    expect(readFileSync(result.outputPath!, "utf8")).toBe(full);
  });
});

