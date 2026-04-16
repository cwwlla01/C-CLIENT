(function () {
  var protocol = window.location.protocol === "https:" ? "https" : "http";
  var wsProtocol = protocol === "https" ? "wss" : "ws";
  var host = window.location.hostname || "127.0.0.1";
  var port = 4281;

  window.__CCLIENT_RUNTIME_CONFIG__ = {
    bridgeHost: host,
    bridgeHttpOrigin: protocol + "://" + host + ":" + port,
    bridgePort: port,
    bridgeWsOrigin: wsProtocol + "://" + host + ":" + port,
    defaultProjectPath: "",
  };
})();
