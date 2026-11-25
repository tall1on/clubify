import { AudioEngine } from "./audio/engine.js";
import { startControlServer } from "./server/control-server.js";
import { loadConfig } from "./server/config-store.js";
import type { EnginePhase } from "./shared/types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const engine = new AudioEngine(config);
  const server = await startControlServer(engine, 8787);
  await engine.start();

  let lastPhase: EnginePhase | null = null;
  engine.on("status", (status) => {
    if (status.phase !== lastPhase) {
      lastPhase = status.phase;
      console.log(`[clubify] ${status.phase}: ${status.message ?? ""}`);
    }
  });

  const shutdown = async (): Promise<void> => {
    engine.stop();
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGHUP", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error("[clubify] failed to start:", error);
  process.exit(1);
});
