# neoshell

[![CI](https://github.com/nkanf-dev/neoshell/actions/workflows/ci.yml/badge.svg)](https://github.com/nkanf-dev/neoshell/actions/workflows/ci.yml)

Browser-first PowerShell agent control plane.

`neoshell` gives you a remote, authenticated browser surface for a PowerShell-first coding agent. You can talk to the agent, review its plan, watch streaming output, inspect every shell command, and switch into a direct terminal mode without leaving the control plane.

## What It Does

- Plan-aware agent runs with streaming status, plan updates, command events, and final answers.
- PowerShell execution with per-conversation shell state, bounded command policy, timeout recovery, and output spill files for oversized logs.
- Browser control plane with conversation history, rename/archive flows, failure markers, settings, and terminal mode.
- Remote-ready backend with cookie auth, CORS allowlists, rate limiting, Helmet, and structured logs.
- Pluggable OpenAI-compatible providers, including single-provider and multi-provider configuration.

## Product Surface

- `Agent mode`: ask for inspection, planning, execution, and summaries.
- `Terminal mode`: run direct PowerShell commands in the current conversation shell context.
- `Observability`: stream run state, command lifecycle, failures, last event metadata, and current working directory.
- `Conversation operations`: create, rename, archive, restore, clear, and continue threads with preserved context.

## Architecture

- `apps/web`: Vite + React + Tailwind + shadcn/ui control plane.
- `apps/server`: Fastify API, auth, persistence, SSE streaming, agent orchestration, and PowerShell runtime.
- `packages/shared`: shared contracts, event schemas, and cross-app types.

## Quick Start

1. Copy `.env.example` to `.env`.
2. Set a strong `NEOSHELL_ADMIN_PASSWORD`.
3. Configure at least one provider API key.
4. Install dependencies with `bun install`.
5. Start the stack with `bun run dev`.
6. Open `http://localhost:3000`.

Separate dev entry points:

- `bun run dev:server`
- `bun run dev:web`
- `bun run stop:dev`

## Environment

Core settings:

- `NEOSHELL_ADMIN_USERNAME`
- `NEOSHELL_ADMIN_PASSWORD`
- `NEOSHELL_HOST`
- `NEOSHELL_PORT`
- `NEOSHELL_ALLOWED_ORIGINS`
- `NEOSHELL_SECURE_COOKIES`
- `NEOSHELL_LOG_LEVEL`

Provider settings:

- Single provider: `NEOSHELL_PROVIDER_*`
- Multiple providers: `NEOSHELL_PROVIDERS_JSON` + `NEOSHELL_PROVIDER_SECRETS_JSON`

Execution settings:

- `NEOSHELL_PROVIDER_TIMEOUT_MS`
- `NEOSHELL_COMMAND_TIMEOUT_MS`
- `NEOSHELL_WORKSPACE_ROOT`
- `NEOSHELL_SPILL_DIRECTORY`

## Remote Access

For a real deployment:

- Bind the backend to a reachable host with `NEOSHELL_HOST=0.0.0.0`.
- Restrict `NEOSHELL_ALLOWED_ORIGINS` to your real frontend origins.
- Enable `NEOSHELL_SECURE_COOKIES=true` behind HTTPS.
- Put the frontend and backend behind a reverse proxy when possible.
- Keep provider secrets server-side only.

## Observability

`neoshell` is built to make agent runs inspectable instead of opaque:

- Server-side structured logs for auth, conversation lifecycle, run lifecycle, command execution, SSE streams, and auto-titling.
- SSE event streaming for live UI updates.
- Command logs with duration, cwd, timeout state, truncation markers, and spill-file pointers.
- Failure markers tied to the exact user turn that failed.

## Toolchain

- Workspace and package manager: Bun
- Frontend build/dev server: Vite
- Backend server: Fastify
- Test runner: Vitest
- Runtime shell: PowerShell

Windows note:

Use `bun run dev`, `bun run dev:web`, and `bun run dev:server` for long-running watchers. This repo intentionally avoids `bun run --filter ... dev` as the primary workflow because `Ctrl+C` is unreliable on this Windows + watcher process tree.

## Validation

Run the full verification suite:

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

## CI

GitHub Actions runs the same release gate on every push and pull request:

- lint
- typecheck
- test
- build

The workflow lives at `.github/workflows/ci.yml` and runs on [GitHub Actions](https://github.com/nkanf-dev/neoshell/actions/workflows/ci.yml).

## Repository Layout

```text
.
|- apps/
|  |- server/
|  `- web/
|- packages/
|  `- shared/
`- scripts/
```

## Security Notes

- Do not commit `.env` or provider API keys.
- Treat browser automation artifacts, screenshots, and local browser profiles as sensitive.
- Rotate any secret that was ever used in local testing before publishing or deploying.
