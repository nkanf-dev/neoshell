import { buildApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = await buildApp({
  config
});

await app.listen({
  host: config.host,
  port: config.port
});

app.log.info(
  {
    host: config.host,
    port: config.port,
    logLevel: config.logLevel
  },
  "neoshell server listening"
);
