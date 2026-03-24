import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";
import { providerConfigSchema, type ProviderConfig } from "@neoshell/shared";
import { z } from "zod";

export function resolveWorkspaceEnvPath(fromUrl: string = import.meta.url) {
  return resolve(fileURLToPath(new URL(".", fromUrl)), "../../../.env");
}

export function resolveWorkspaceRoot(fromUrl: string = import.meta.url) {
  return resolve(fileURLToPath(new URL(".", fromUrl)), "../../..");
}

loadDotenv({
  path: resolveWorkspaceEnvPath(),
  quiet: true
});

export type NeoshellConfig = {
  adminUsername: string;
  adminPassword: string;
  logLevel: string;
  databasePath: string;
  workspaceRoot: string;
  spillDirectory: string;
  sessionCookieName: string;
  secureCookies: boolean;
  host: string;
  port: number;
  allowedOrigins: string[];
  sessionTtlHours: number;
  providerTimeoutMs: number;
  commandTimeoutMs: number;
  providers: ProviderConfig[];
  providerSecrets: Record<string, string>;
};

export function loadConfig(): NeoshellConfig {
  const defaultProviderId = process.env.NEOSHELL_PROVIDER_ID ?? "default";
  const defaultProvider: ProviderConfig = {
    providerId: defaultProviderId,
    label: process.env.NEOSHELL_PROVIDER_LABEL ?? "Default Provider",
    kind: "openai_compatible",
    baseUrl: process.env.NEOSHELL_PROVIDER_BASE_URL ?? "https://api.example.com/v1",
    model: process.env.NEOSHELL_PROVIDER_MODEL ?? "provider/chat-model",
    supportsReasoning: true
  };

  const providers = process.env.NEOSHELL_PROVIDERS_JSON
    ? z.array(providerConfigSchema).parse(JSON.parse(process.env.NEOSHELL_PROVIDERS_JSON))
    : [defaultProvider];

  const providerSecrets = process.env.NEOSHELL_PROVIDER_SECRETS_JSON
    ? z.record(z.string(), z.string()).parse(JSON.parse(process.env.NEOSHELL_PROVIDER_SECRETS_JSON))
    : {
        [defaultProviderId]: process.env.NEOSHELL_PROVIDER_API_KEY ?? ""
      };

  return {
    adminUsername: process.env.NEOSHELL_ADMIN_USERNAME ?? "admin",
    adminPassword: process.env.NEOSHELL_ADMIN_PASSWORD ?? "change-me-before-deploy",
    logLevel: process.env.NEOSHELL_LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info"),
    databasePath: process.env.NEOSHELL_DATABASE_PATH ?? "./data/neoshell.sqlite",
    workspaceRoot: process.env.NEOSHELL_WORKSPACE_ROOT ?? resolveWorkspaceRoot(),
    spillDirectory: process.env.NEOSHELL_SPILL_DIRECTORY ?? "./data/spills",
    sessionCookieName: process.env.NEOSHELL_SESSION_COOKIE_NAME ?? "neoshell_session",
    secureCookies: (process.env.NEOSHELL_SECURE_COOKIES ?? "false") === "true",
    host: process.env.NEOSHELL_HOST ?? "0.0.0.0",
    port: Number(process.env.NEOSHELL_PORT ?? "4000"),
    allowedOrigins: (process.env.NEOSHELL_ALLOWED_ORIGINS ??
      "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3002,http://127.0.0.1:3002,http://localhost:5173,http://127.0.0.1:5173")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    sessionTtlHours: Number(process.env.NEOSHELL_SESSION_TTL_HOURS ?? "168"),
    providerTimeoutMs: Number(process.env.NEOSHELL_PROVIDER_TIMEOUT_MS ?? "60000"),
    commandTimeoutMs: Number(process.env.NEOSHELL_COMMAND_TIMEOUT_MS ?? "45000"),
    providers,
    providerSecrets
  };
}
