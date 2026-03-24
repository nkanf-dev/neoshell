import { describe, expect, it } from "vitest";

import {
  buildWrappedCommand,
  parseCompletedCommand,
  PersistentPowerShellSession
} from "../../src/runtime/persistent-powershell-session";

describe("persistent PowerShell session helpers", () => {
  it("wraps commands with cwd setup and a sentinel", () => {
    const wrapped = buildWrappedCommand({
      command: "Get-Location",
      cwd: "C:\\Users\\ws200\\Downloads\\neoshell",
      sentinel: "__NEOSHELL_DONE__"
    });

    expect(wrapped).toContain("Set-Location -LiteralPath 'C:\\Users\\ws200\\Downloads\\neoshell'");
    expect(wrapped).toContain("FromBase64String");
    expect(wrapped).toContain("__NEOSHELL_DONE__");
  });

  it("strips echoed commands and parses exit codes", () => {
    const result = parseCompletedCommand({
      command: "Get-Location",
      combinedOutput:
        "Get-Location\r\nC:\\work\r\n__NEOSHELL_DONE__ EXIT 0\r\n__NEOSHELL_DONE__ CWD Qzpcd29yaw==\r\n",
      sentinel: "__NEOSHELL_DONE__"
    });

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("C:\\work");
    expect(result.currentCwd).toBe("C:\\work");
  });

  it.skipIf(process.platform !== "win32")(
    "executes a real command in a persistent shell session",
    { timeout: 15000 },
    async () => {
      const session = new PersistentPowerShellSession("powershell.exe");

      try {
        const result = await session.run("Write-Output (Get-Location).Path", process.cwd());

        expect(result.exitCode).toBe(0);
        expect(result.output.trim()).toBe(process.cwd());
        expect(result.currentCwd).toBe(process.cwd());
      } finally {
        session.dispose();
      }
    }
  );
});
