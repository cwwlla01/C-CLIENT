import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import "./terminal-window.css";
import type { RuntimeMember } from "../data/mock-runtime";

type TerminalWindowProps = {
  apiKey?: string;
  apiKeyEnabled?: boolean;
  bridgeHttpOrigin?: string;
  bridgeWsOrigin?: string;
  configuredModel?: string;
  configuredReasoning?: string;
  member: RuntimeMember | null;
  onClose: () => void;
  terminalFontSize?: number;
};

type BridgeConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

const stateToneMap: Record<BridgeConnectionState, string> = {
  connecting: "text-orange-300",
  connected: "text-emerald-300",
  disconnected: "text-slate-400",
  error: "text-red-300",
};

export function TerminalWindow({
  apiKey = "",
  apiKeyEnabled = false,
  bridgeHttpOrigin = "http://127.0.0.1:4281",
  bridgeWsOrigin = "ws://127.0.0.1:4281",
  configuredModel = "",
  configuredReasoning = "",
  member,
  onClose,
  terminalFontSize = 13,
}: TerminalWindowProps) {
  const activeCursorColor = "#F8FAFC";
  const [connectionState, setConnectionState] =
    useState<BridgeConnectionState>("connecting");
  const [connectionLabel, setConnectionLabel] = useState("连接本地 bridge...");
  const [autoFollow, setAutoFollow] = useState(true);
  const [hasUnreadOutput, setHasUnreadOutput] = useState(false);
  const [suppressedNoiseCount, setSuppressedNoiseCount] = useState(0);
  const [lastSuppressedNoise, setLastSuppressedNoise] = useState("");
  const [liveCodexSessionId, setLiveCodexSessionId] = useState("");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const inputCursorTimerRef = useRef<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const autoFollowRef = useRef(true);
  const hasVisibleOutputRef = useRef(false);

  const bridgeUrl = useMemo(() => {
    if (!member) {
      return "";
    }

    const params = new URLSearchParams({
      attachOnly: "1",
      memberId: member.id,
      shell: member.shell,
      cwd: member.workspace,
      cols: "120",
      rows: "30",
      ...(apiKeyEnabled && apiKey.trim() ? { token: apiKey.trim() } : {}),
    });

    const normalizedOrigin = bridgeWsOrigin.replace(/\/+$/, "");
    return `${normalizedOrigin}/terminal?${params.toString()}`;
  }, [apiKey, apiKeyEnabled, bridgeWsOrigin, member?.id, member?.shell, member?.workspace]);

  const runtimeShellLabel = member?.runtimeInfo?.resolvedShell ?? member?.shell ?? "";
  const memberName = member?.name ?? "";

  const classifyNoise = (text: string) => {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "";
    }

    if (/MCP client .* failed to start/i.test(normalized)) {
      return "MCP 客户端启动失败";
    }
    if (/MCP startup incomplete/i.test(normalized)) {
      return "MCP 启动未完成";
    }
    if (/not logged in\. Run `codex mcp login/i.test(normalized)) {
      return "MCP 未登录提示";
    }
    if (/plugin is not installed/i.test(normalized)) {
      return "插件未安装提示";
    }
    if (/startup remote plugin sync failed/i.test(normalized)) {
      return "远程插件同步失败";
    }
    if (/failed to warm featured plugin ids cache/i.test(normalized)) {
      return "插件缓存预热失败";
    }
    if (/chatgpt authentication required to sync remote plugins/i.test(normalized)) {
      return "远程插件鉴权失败";
    }

    return "";
  };

  useEffect(() => {
    autoFollowRef.current = autoFollow;
  }, [autoFollow]);

  const sendCommand = (text: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(
      JSON.stringify({
        type: "input",
        data: text,
      }),
    );
    return true;
  };

  useEffect(() => {
    setLiveCodexSessionId(member?.runtimeInfo?.codexSessionId ?? "");
  }, [member?.id, member?.runtimeInfo?.codexSessionId]);

  useEffect(() => {
    if (!member?.workspace) {
      return;
    }

    let cancelled = false;
    const normalizedOrigin = bridgeHttpOrigin.replace(/\/+$/, "");

    const loadStatus = async () => {
      try {
        const response = await fetch(`${normalizedOrigin}/api/employee/status`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKeyEnabled && apiKey.trim() ? { "X-CClient-Key": apiKey.trim() } : {}),
          },
          body: JSON.stringify({
            workspacePath: member.workspace,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          return;
        }
        if (!cancelled) {
          const nextCodexSessionId =
            payload?.status?.codexSessionId ||
            payload?.status?.inspector?.codexSessionId ||
            "";
          if (typeof nextCodexSessionId === "string") {
            setLiveCodexSessionId(nextCodexSessionId);
          }
        }
      } catch {
        // ignore terminal metadata refresh errors
      }
    };

    void loadStatus();
    const timer = window.setInterval(() => {
      void loadStatus();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [apiKey, apiKeyEnabled, bridgeHttpOrigin, member?.workspace]);

  useEffect(() => {
    if (!member || !containerRef.current) {
      return;
    }

    setAutoFollow(true);
    setHasUnreadOutput(false);
    setSuppressedNoiseCount(0);
    setLastSuppressedNoise("");
    hasVisibleOutputRef.current = false;

    const terminalTheme = {
      background: "#070C18",
      black: "#0F172A",
      blue: "#60A5FA",
      brightBlack: "#475569",
      brightBlue: "#93C5FD",
      brightCyan: "#67E8F9",
      brightGreen: "#86EFAC",
      brightMagenta: "#C4B5FD",
      brightRed: "#FCA5A5",
      brightWhite: "#F8FAFC",
      brightYellow: "#FCD34D",
      cursor: activeCursorColor,
      cyan: "#22D3EE",
      foreground: "#E2E8F0",
      green: "#4ADE80",
      magenta: "#A78BFA",
      red: "#F87171",
      selectionBackground: "rgba(148, 163, 184, 0.24)",
      white: "#F8FAFC",
      yellow: "#FBBF24",
    } as const;

    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      cursorStyle: "bar",
      cursorWidth: 1,
      disableStdin: false,
      fontFamily: '"Cascadia Code", "JetBrains Mono", "Consolas", monospace',
      fontSize: terminalFontSize,
      lineHeight: 1.5,
      scrollback: 4000,
      theme: terminalTheme,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();
    terminal.writeln(`Connecting to ${memberName}...`);
    terminal.focus();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const socket = new WebSocket(bridgeUrl);
    socketRef.current = socket;
    setConnectionState("connecting");
    setConnectionLabel("连接本地 bridge...");

    const sendResize = () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      }
    };

    const setCursorMuted = (muted: boolean) => {
      containerRef.current?.classList.toggle("terminal-surface--cursor-muted", muted);
      terminal.options.theme = {
        ...terminalTheme,
        cursor: muted ? "rgba(248, 250, 252, 0)" : activeCursorColor,
      };
    };

    const showCursorTemporarily = () => {
      if (inputCursorTimerRef.current) {
        window.clearTimeout(inputCursorTimerRef.current);
      }

      setCursorMuted(false);
      inputCursorTimerRef.current = window.setTimeout(() => {
        setCursorMuted(true);
        inputCursorTimerRef.current = null;
      }, 700);
    };

    setCursorMuted(true);

    const normalizeDisplayChunk = (text: string) => {
      let next = String(text || "");
      if (!next) {
        return "";
      }

      if (!hasVisibleOutputRef.current) {
        next = next.replace(/^(?:\r?\n|\r)+/, "");
      }

      next = next.replace(/(\r?\n|\r){3,}/g, "\r\n\r\n");

      if (next.trim()) {
        hasVisibleOutputRef.current = true;
      }

      return next;
    };

    const handleTerminalInput = terminal.onData((data) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }

      showCursorTemporarily();
      sendCommand(data);
    });

    const handleTerminalScroll = terminal.onScroll((viewportY) => {
      const buffer = terminal.buffer.active;
      const atBottom = viewportY >= buffer.baseY;
      setAutoFollow(atBottom);
      if (atBottom) {
        setHasUnreadOutput(false);
      }
    });

    socket.onopen = () => {
      fitAddon.fit();
      sendResize();
      terminal.focus();
    };

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data as string);

      if (payload.type === "ready") {
        setConnectionState("connected");
        setConnectionLabel(
          payload.reused ? "已附着现有会话" : "已创建新的本地 CLI 会话",
        );
        terminal.writeln(
          `\r\n[bridge] session ${payload.sessionId} ready (${payload.shell})\r\n`,
        );
        terminal.focus();
        return;
      }

      if (payload.type === "output") {
        const noiseLabel = classifyNoise(payload.data);
        if (noiseLabel) {
          setSuppressedNoiseCount((current) => current + 1);
          setLastSuppressedNoise(noiseLabel);
          return;
        }
        const normalizedData = normalizeDisplayChunk(payload.data);
        if (!normalizedData) {
          return;
        }
        setCursorMuted(true);
        const previousViewportY = terminal.buffer.active.viewportY;
        terminal.write(normalizedData);
        if (!autoFollowRef.current) {
          requestAnimationFrame(() => {
            terminal.scrollToLine(previousViewportY);
          });
          setHasUnreadOutput(true);
        }
        return;
      }

      if (payload.type === "meta") {
        const noiseLabel = classifyNoise(payload.data);
        if (noiseLabel) {
          setSuppressedNoiseCount((current) => current + 1);
          setLastSuppressedNoise(noiseLabel);
          return;
        }
        const normalizedData = normalizeDisplayChunk(payload.data);
        if (!normalizedData) {
          return;
        }
        setCursorMuted(true);
        const previousViewportY = terminal.buffer.active.viewportY;
        terminal.writeln(normalizedData.replace(/\r?\n$/, ""));
        if (!autoFollowRef.current) {
          requestAnimationFrame(() => {
            terminal.scrollToLine(previousViewportY);
          });
          setHasUnreadOutput(true);
        }
        return;
      }

      if (payload.type === "exit") {
        setCursorMuted(false);
        setConnectionState("disconnected");
        setConnectionLabel("会话已退出");
        terminal.writeln(
          `\r\n[bridge] session exited with code ${payload.exitCode ?? "unknown"}\r\n`,
        );
        return;
      }

      if (payload.type === "error") {
        setCursorMuted(false);
        setConnectionState("error");
        setConnectionLabel(payload.message || "bridge 返回错误");
        terminal.writeln(`\r\n[bridge error] ${payload.message}\r\n`);
      }
    };

    socket.onerror = () => {
      setCursorMuted(false);
      setConnectionState("error");
      setConnectionLabel("无法连接本地 CLI bridge");
      terminal.writeln(
        "\r\n[bridge error] 无法连接到本地 bridge，请先运行 npm run bridge 或 npm run dev:all\r\n",
      );
    };

    socket.onclose = () => {
      setConnectionState((current) =>
        current === "error" ? "error" : "disconnected",
      );
      setConnectionLabel((current) =>
        current === "无法连接本地 CLI bridge" ? current : "连接已关闭",
      );
    };

    const handleResize = () => {
      fitAddon.fit();
      sendResize();
    };

    const handleFocusTerminal = () => {
      setCursorMuted(true);
      terminal.focus();
    };

    window.addEventListener("resize", handleResize);
    containerRef.current.addEventListener("click", handleFocusTerminal);

    return () => {
      window.removeEventListener("resize", handleResize);
      containerRef.current?.removeEventListener("click", handleFocusTerminal);
      if (inputCursorTimerRef.current) {
        window.clearTimeout(inputCursorTimerRef.current);
        inputCursorTimerRef.current = null;
      }
      handleTerminalInput.dispose();
      handleTerminalScroll.dispose();
      socket.close();
      terminal.dispose();
      fitAddonRef.current = null;
      terminalRef.current = null;
      socketRef.current = null;
    };
  }, [bridgeUrl, member?.id, memberName, terminalFontSize]);

  if (!member) {
    return null;
  }

  return (
    <dialog open className="modal z-50 bg-[#020617]/72 backdrop-blur-sm">
      <div className="modal-box flex max-w-[1080px] flex-col overflow-hidden bg-neutral p-0 text-neutral-content shadow-xl">
        <div className="navbar gap-3 border-b border-neutral-content/10 bg-neutral px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-neutral-content">
              {runtimeShellLabel} · {member.name}
            </p>
            <p className="truncate text-xs text-neutral-content/60">{member.workspace}</p>
          </div>
          <div className="flex items-center gap-2">
            {suppressedNoiseCount > 0 ? (
              <span className="badge badge-outline border-warning/30 text-warning">
                已折叠噪音 {suppressedNoiseCount}
              </span>
            ) : null}
            <button
              className={`btn btn-ghost btn-xs ${autoFollow ? "" : "text-warning"}`}
              onClick={() => {
                const terminal = terminalRef.current;
                if (!terminal) {
                  return;
                }
                if (autoFollow) {
                  setAutoFollow(false);
                  return;
                }
                terminal.scrollToBottom();
                setAutoFollow(true);
                setHasUnreadOutput(false);
                terminal.focus();
              }}
              type="button"
            >
              {autoFollow ? "暂停跟随" : "恢复跟随"}
            </button>
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => {
                terminalRef.current?.clear();
                setHasUnreadOutput(false);
                hasVisibleOutputRef.current = false;
              }}
              type="button"
            >
              清屏
            </button>
          </div>
          <span className={`text-xs font-medium ${stateToneMap[connectionState]}`}>
            {connectionLabel}
          </span>
          <button
            className="btn btn-ghost btn-xs"
            onClick={onClose}
            type="button"
          >
            关闭
          </button>
        </div>

        <div className="flex-1 bg-[#070C18] px-4 py-4">
          <div
            ref={containerRef}
            className="h-full min-h-[560px] w-full overflow-hidden rounded-box border border-neutral-content/10 bg-[#070C18]"
          />
        </div>

        <div className="border-t border-neutral-content/10 bg-neutral px-5 py-3">
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-box border border-neutral-content/10 bg-[#0B1220] px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.16em] text-neutral-content/50">本地会话</p>
                <p className="mt-2 break-all text-sm text-neutral-content">{member.runtimeInfo?.sessionId || "-"}</p>
              </div>
              <div className="rounded-box border border-neutral-content/10 bg-[#0B1220] px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.16em] text-neutral-content/50">Codex 会话</p>
                <p className="mt-2 break-all text-sm text-neutral-content">{liveCodexSessionId || "待发现"}</p>
              </div>
              <div className="rounded-box border border-neutral-content/10 bg-[#0B1220] px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.16em] text-neutral-content/50">配置模型</p>
                <p className="mt-2 text-sm text-neutral-content">
                  {configuredModel || "-"}
                  {configuredReasoning ? ` · ${configuredReasoning}` : ""}
                </p>
              </div>
              <div className="rounded-box border border-neutral-content/10 bg-[#0B1220] px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.16em] text-neutral-content/50">进程 / 权限</p>
                <p className="mt-2 text-sm text-neutral-content">
                  pid {typeof member.runtimeInfo?.pid === "number" ? member.runtimeInfo.pid : "-"} · {member.permission}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-content/60">
              <span className="badge badge-outline border-neutral-content/15 text-neutral-content/70">Codex 基本信息</span>
              <span className={`badge badge-outline border-neutral-content/15 ${autoFollow ? "text-emerald-300" : "text-warning"}`}>
                {autoFollow ? "跟随输出中" : "已暂停跟随"}
              </span>
              {hasUnreadOutput ? (
                <span className="badge badge-outline border-neutral-content/15 text-warning">
                  有新输出
                </span>
              ) : null}
              {lastSuppressedNoise ? (
                <span className="text-warning">最近折叠：{lastSuppressedNoise}</span>
              ) : null}
              <span>终端区域保留原生交互</span>
              <span>Ctrl+C 可直接中断</span>
              <span>如需输入，直接在终端区域键入</span>
            </div>
          </div>
        </div>
      </div>
      <form className="modal-backdrop" method="dialog">
        <button onClick={onClose} type="button">
          关闭
        </button>
      </form>
    </dialog>
  );
}
