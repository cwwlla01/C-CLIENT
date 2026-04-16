/// <reference types="vite/client" />

interface Window {
  __CCLIENT_RUNTIME_CONFIG__?: {
    bridgeHost?: string;
    bridgeHttpOrigin?: string;
    bridgePort?: number | string;
    bridgeWsOrigin?: string;
    defaultProjectPath?: string;
  };
}
