import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage } from "../shared/types.js";
import type { AudioEngine } from "../audio/engine.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export interface ControlServer {
  port: number;
  close: () => Promise<void>;
}

export async function startControlServer(
  engine: AudioEngine,
  port: number,
): Promise<ControlServer> {
  const uiDirectory = resolve(process.cwd(), "ui", "dist");
  let clientCount = 0;
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ ok: true, clients: clientCount, status: engine.getState(false).status }),
      );
      return;
    }
    if (url.pathname === "/api/state") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(engine.getState(true)));
      return;
    }
    serveStatic(uiDirectory, url.pathname, response);
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const broadcast = (message: ServerMessage): void => {
    const serialized = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(serialized);
    }
  };

  wss.on("connection", (socket) => {
    clientCount += 1;
    console.log(`[clubify] UI connected (${clientCount} client${clientCount === 1 ? "" : "s"})`);
    socket.on("close", () => {
      clientCount = Math.max(0, clientCount - 1);
    });
    socket.send(JSON.stringify({ type: "state", state: engine.getState(true) } satisfies ServerMessage));
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as ClientMessage;
        handleMessage(engine, message);
        broadcast({ type: "state", state: engine.getState(false) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        socket.send(JSON.stringify({ type: "error", message } satisfies ServerMessage));
      }
    });
  });

  const onStatus = (): void => {
    broadcast({ type: "state", state: engine.getState(false) });
  };
  engine.on("status", onStatus);

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Clubify control UI: http://127.0.0.1:${actualPort}`);

  return {
    port: actualPort,
    close: async () => {
      engine.off("status", onStatus);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
      await closeHttpServer(httpServer);
    },
  };
}

function handleMessage(engine: AudioEngine, message: ClientMessage): void {
  switch (message.type) {
    case "set-effects":
      engine.setEffects(message.effects);
      break;
    case "set-preset":
      engine.setPreset(message.presetId);
      break;
    case "save-preset":
      engine.savePreset(message.name);
      break;
    case "delete-preset":
      engine.deletePreset(message.presetId);
      break;
    case "set-output-device":
      engine.setOutputDevice(message.deviceName);
      break;
    case "set-buffer":
      engine.setBufferMs(message.ms);
      break;
    case "set-auto-gain":
      engine.setAutoGain(message.enabled);
      break;
    case "set-bypass":
      engine.setBypass(message.bypass);
      break;
    case "restart":
      engine.restart();
      break;
    case "request-state":
      break;
    default:
      throw new Error("Unknown control message");
  }
}

function serveStatic(
  uiDirectory: string,
  pathname: string,
  response: import("node:http").ServerResponse,
): void {
  if (!existsSync(uiDirectory)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("UI build not found. Run `npm run ui:build`, or use `npm run ui:dev`.");
    return;
  }
  const safePath = normalize(pathname).replace(/^([/\\])+/, "");
  let filePath = resolve(uiDirectory, safePath === "" ? "index.html" : safePath);
  if (!filePath.startsWith(uiDirectory)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(uiDirectory, "index.html");
  }
  if (!existsSync(filePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const extension = extname(filePath).toLowerCase();
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extension] ?? "application/octet-stream",
    "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=3600",
  });
  response.end(readFileSync(filePath));
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
}
