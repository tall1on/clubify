import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { startControlServer, type ControlServer } from "./server/control-server.js";
import { loadConfig } from "./server/config-store.js";
import { AudioEngine } from "./audio/engine.js";
import type { EnginePhase } from "./shared/types.js";

const SHUTDOWN_TIMEOUT_MS = 5_000;

function enginePort(): number {
  const value = Number(process.env.CLUBIFY_ENGINE_PORT ?? 8787);
  return Number.isInteger(value) && value > 0 && value < 65_536 ? value : 8787;
}

/**
 * The engine runs in a worker thread so the HTTP server, WebSocket clients and
 * the supervisor can never block the DSP or the output pump. The main thread
 * only supervises lifecycle and relays shutdown.
 */
if (isMainThread) {
  runSupervisor();
} else {
  void runEngineWorker();
}

function runSupervisor(): void {
  const worker = new Worker(new URL(import.meta.url), {
    execArgv: import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [],
  });

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    worker.postMessage("shutdown");
    const timer = setTimeout(() => {
      void worker.terminate().finally(() => process.exit(code));
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    worker.once("message", (message: unknown) => {
      if (message === "stopped") {
        clearTimeout(timer);
        process.exit(code);
      }
    });
  };

  worker.on("error", (error) => {
    console.error("[clubify] audio engine crashed:", error);
    shuttingDown = true;
    process.exit(1);
  });
  worker.on("exit", (code) => {
    if (!shuttingDown) process.exit(code ?? 1);
  });

  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGHUP", () => shutdown(0));
}

async function runEngineWorker(): Promise<void> {
  let engine: AudioEngine | null = null;
  let server: ControlServer | null = null;
  let stopping = false;

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      engine?.stop();
      await server?.close();
    } catch (error) {
      console.error("[clubify] shutdown failed:", error);
    }
    parentPort?.postMessage("stopped");
    setImmediate(() => process.exit(0));
  };

  parentPort?.on("message", (message: unknown) => {
    if (message === "shutdown") void shutdown();
  });

  try {
    const config = loadConfig();
    engine = new AudioEngine(config);
    server = await startControlServer(engine, enginePort());
    await engine.start();

    let lastPhase: EnginePhase | null = null;
    engine.on("status", (status) => {
      if (status.phase !== lastPhase) {
        lastPhase = status.phase;
        console.log(`[clubify] ${status.phase}: ${status.message ?? ""}`);
      }
    });
  } catch (error) {
    console.error("[clubify] failed to start:", error);
    process.exit(1);
  }
}
