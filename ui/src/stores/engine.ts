import { defineStore } from "pinia";
import { ref } from "vue";
import type {
  ClientMessage,
  DspParams,
  PublicState,
  ServerMessage,
} from "../../../src/shared/types";

export type ConnectionState = "connecting" | "open" | "closed";

const ENGINE_PORT = "8787";

function socketUrl(): string {
  const port = import.meta.env.VITE_ENGINE_PORT ?? ENGINE_PORT;
  if (window.location.port === port) {
    return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
  }
  const host = window.location.hostname;
  const engineHost = host === "localhost" || host === "127.0.0.1" ? host : "127.0.0.1";
  return `ws://${engineHost}:${port}/ws`;
}

export const useEngineStore = defineStore("engine", () => {
  const state = ref<PublicState | null>(null);
  const connection = ref<ConnectionState>("connecting");
  const socketError = ref<string | null>(null);

  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let disposed = false;

  function open() {
    if (disposed) return;
    connection.value = "connecting";
    const next = new WebSocket(socketUrl());
    socket = next;
    next.onopen = () => {
      connection.value = "open";
      socketError.value = null;
    };
    next.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as ServerMessage;
        if (message.type === "state") state.value = message.state;
        if (message.type === "error") socketError.value = message.message;
      } catch {
        socketError.value = "Received an invalid engine message";
      }
    };
    next.onerror = () => {
      socketError.value = "Could not reach the Clubify engine";
    };
    next.onclose = () => {
      if (disposed || socket !== next) return;
      connection.value = "closed";
      reconnectTimer = window.setTimeout(open, 1500);
    };
  }

  function connect() {
    disposed = false;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close();
    open();
  }

  function disconnect() {
    disposed = true;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close();
    socket = null;
  }

  function send(message: ClientMessage) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function setEffects(effects: Partial<DspParams>) {
    send({ type: "set-effects", effects });
  }

  function setPreset(presetId: string) {
    send({ type: "set-preset", presetId });
  }

  function setOutputDevice(deviceName: string | null) {
    send({ type: "set-output-device", deviceName });
  }

  function setBuffer(ms: number) {
    send({ type: "set-buffer", ms });
  }

  function setAutoGain(enabled: boolean) {
    send({ type: "set-auto-gain", enabled });
  }

  function setBypass(bypass: boolean) {
    send({ type: "set-bypass", bypass });
  }

  function restart() {
    send({ type: "restart" });
  }

  function requestState() {
    send({ type: "request-state" });
  }

  return {
    state,
    connection,
    socketError,
    connect,
    disconnect,
    send,
    setEffects,
    setPreset,
    setOutputDevice,
    setBuffer,
    setAutoGain,
    setBypass,
    restart,
    requestState,
  };
});
