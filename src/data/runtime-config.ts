export type RuntimePublicConfig = {
  bridgeHost: string;
  bridgeHttpOrigin: string;
  bridgePort: number;
  bridgeWsOrigin: string;
  defaultProjectPath: string;
};

function normalizePort(value: unknown, fallback: number) {
  const port = Number(value);
  if (!Number.isFinite(port) || port <= 0) {
    return fallback;
  }
  return port;
}

function buildDefaults() {
  const defaultWindowHost =
    typeof window !== "undefined" ? window.location.hostname || "127.0.0.1" : "127.0.0.1";
  const defaultHttpProtocol =
    typeof window !== "undefined" && window.location.protocol === "https:" ? "https" : "http";
  const defaultWsProtocol = defaultHttpProtocol === "https" ? "wss" : "ws";
  const defaultBridgePort = normalizePort(import.meta.env.VITE_BRIDGE_PORT, 4281);
  const defaultBridgeHost = import.meta.env.VITE_BRIDGE_HOST || defaultWindowHost;
  const defaultBridgeHttpOrigin =
    import.meta.env.VITE_BRIDGE_ORIGIN || `${defaultHttpProtocol}://${defaultBridgeHost}:${defaultBridgePort}`;
  const defaultBridgeWsOrigin =
    import.meta.env.VITE_BRIDGE_WS_ORIGIN || `${defaultWsProtocol}://${defaultBridgeHost}:${defaultBridgePort}`;

  return {
    bridgeHost: defaultBridgeHost,
    bridgeHttpOrigin: defaultBridgeHttpOrigin,
    bridgePort: defaultBridgePort,
    bridgeWsOrigin: defaultBridgeWsOrigin,
    defaultProjectPath: import.meta.env.VITE_DEFAULT_PROJECT_PATH || "D:/PROJECT/COMPANY",
  } satisfies RuntimePublicConfig;
}

function readRuntimeConfig() {
  const defaults = buildDefaults();
  const runtime = typeof window !== "undefined" ? window.__CCLIENT_RUNTIME_CONFIG__ || {} : {};

  return {
    bridgeHost: String(runtime.bridgeHost || defaults.bridgeHost),
    bridgeHttpOrigin: String(runtime.bridgeHttpOrigin || defaults.bridgeHttpOrigin),
    bridgePort: normalizePort(runtime.bridgePort, defaults.bridgePort),
    bridgeWsOrigin: String(runtime.bridgeWsOrigin || defaults.bridgeWsOrigin),
    defaultProjectPath: String(runtime.defaultProjectPath || defaults.defaultProjectPath),
  } satisfies RuntimePublicConfig;
}

export const runtimePublicConfig = readRuntimeConfig();
