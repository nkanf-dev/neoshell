import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

function escapeSingleQuotedPowerShellString(value: string): string {
  return value.replaceAll("'", "''");
}

export function buildWrappedCommand(params: {
  command: string;
  cwd: string;
  sentinel: string;
}): string {
  const cwd = escapeSingleQuotedPowerShellString(params.cwd);
  const sentinel = escapeSingleQuotedPowerShellString(params.sentinel);
  const encodedCommand = Buffer.from(params.command, "utf8").toString("base64");

  return [
    `$neoshellSentinel = '${sentinel}'`,
    `$neoshellCommand = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedCommand}'))`,
    `Set-Location -LiteralPath '${cwd}'`,
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$neoshellExit = 0",
    "$global:LASTEXITCODE = 0",
    "try { Invoke-Expression $neoshellCommand; if ($LASTEXITCODE) { $neoshellExit = $LASTEXITCODE } } catch { $neoshellExit = 1; $_ | Out-String -Width 4096 | Write-Output }",
    '$neoshellCwd = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((Get-Location).Path))',
    'Write-Output "$neoshellSentinel EXIT $neoshellExit"',
    'Write-Output "$neoshellSentinel CWD $neoshellCwd"'
  ].join("; ") + "\n";
}

export function parseCompletedCommand(params: {
  command: string;
  combinedOutput: string;
  sentinel: string;
}): {
  output: string;
  exitCode: number;
  currentCwd: string;
} {
  const exitMarker = params.combinedOutput.lastIndexOf(`${params.sentinel} EXIT `);
  if (exitMarker === -1) {
    throw new Error("Command output did not include the sentinel marker");
  }

  const before = params.combinedOutput.slice(0, exitMarker);
  const trailer = params.combinedOutput.slice(exitMarker);
  const exitMatch = trailer.match(new RegExp(`${params.sentinel}\\s+EXIT\\s+(\\d+)`));
  if (!exitMatch) {
    throw new Error("Command output did not include an exit code");
  }
  const cwdMatch = trailer.match(new RegExp(`${params.sentinel}\\s+CWD\\s+([^\\r\\n]+)`));
  if (!cwdMatch?.[1]) {
    throw new Error("Command output did not include a current working directory");
  }

  const lines = before.split(/\r?\n/);
  const commandLines = params.command.split(/\r?\n/).map((line) => line.trim());
  const filtered = [...lines];
  while (filtered.length > 0 && commandLines.includes((filtered[0] ?? "").trim())) {
    filtered.shift();
  }

  return {
    output: filtered.join("\n").replace(/\s+$/, ""),
    exitCode: Number(exitMatch[1]),
    currentCwd: Buffer.from(cwdMatch[1], "base64").toString("utf8")
  };
}

export class PersistentPowerShellSession {
  private shell: ChildProcessWithoutNullStreams | undefined;

  constructor(
    private readonly executable =
      process.env.NEOSHELL_POWERSHELL_PATH ??
      (process.platform === "win32" ? "powershell.exe" : "pwsh")
  ) {}

  private ensureShell(): ChildProcessWithoutNullStreams {
    if (!this.shell) {
      this.shell = spawn(this.executable, ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"], {
        stdio: "pipe"
      });
      this.shell.once("exit", () => {
        this.shell = undefined;
      });
    }
    return this.shell;
  }

  async run(command: string, cwd: string): Promise<{ output: string; exitCode: number; currentCwd: string }> {
    const shell = this.ensureShell();
    const sentinel = `__NEOSHELL_DONE__${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const wrapped = `${buildWrappedCommand({ command, cwd, sentinel })}\n`;

    return new Promise((resolve, reject) => {
      let buffer = "";
      let stderr = "";

      const onStdout = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (!buffer.includes(`${sentinel} EXIT`) || !buffer.includes(`${sentinel} CWD`)) {
          return;
        }

        cleanup();
        try {
          const parsed = parseCompletedCommand({
            command,
            combinedOutput: buffer,
            sentinel
          });
          resolve({
            output: [parsed.output, stderr.trim()].filter(Boolean).join("\n"),
            exitCode: parsed.exitCode,
            currentCwd: parsed.currentCwd
          });
        } catch (error) {
          reject(error);
        }
      };

      const onStderr = (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const onExit = () => {
        cleanup();
        reject(new Error("PowerShell session exited before the command completed"));
      };

      const cleanup = () => {
        shell.stdout.off("data", onStdout);
        shell.stderr.off("data", onStderr);
        shell.off("error", onError);
        shell.off("exit", onExit);
      };

      shell.stdout.on("data", onStdout);
      shell.stderr.on("data", onStderr);
      shell.on("error", onError);
      shell.on("exit", onExit);
      shell.stdin.write(wrapped, "utf8");
    });
  }

  dispose(): void {
    const shell = this.shell;
    this.shell = undefined;
    if (!shell) {
      return;
    }

    try {
      shell.stdin.end("exit\n");
    } catch {
      // Ignore shutdown errors while tearing down a timed-out session.
    }
    if (!shell.killed) {
      shell.kill();
    }
  }
}
