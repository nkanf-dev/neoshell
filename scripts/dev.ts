import { spawn } from "node:child_process";

type DevChild = {
  name: string;
  child: ReturnType<typeof spawn>;
};

const bunExecutable = process.execPath;
const children: DevChild[] = [];
let shuttingDown = false;

function startChild(name: string, cwd: string) {
  const child = spawn(bunExecutable, ["run", "dev"], {
    cwd,
    stdio: "inherit",
    env: process.env
  });

  const entry = { name, child };
  children.push(entry);

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const reason =
      signal !== null
        ? `${name} exited after signal ${signal}`
        : `${name} exited with code ${code ?? 0}`;
    console.error(`[neoshell] ${reason}`);
    void shutdown(code ?? 1);
  });

  child.on("error", (error) => {
    if (shuttingDown) {
      return;
    }
    console.error(`[neoshell] failed to start ${name}: ${error.message}`);
    void shutdown(1);
  });

  return entry;
}

async function killChild(entry: DevChild) {
  const { child } = entry;
  if (child.exitCode !== null || child.killed) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolveChildKill) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore"
      });
      killer.on("exit", () => resolveChildKill());
      killer.on("error", () => resolveChildKill());
    });
    return;
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolveChildKill) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolveChildKill();
    }, 2_000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolveChildKill();
    });
  });
}

async function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  await Promise.all(children.map((entry) => killChild(entry)));
  process.exit(code);
}

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

startChild("server", "apps/server");
startChild("web", "apps/web");
