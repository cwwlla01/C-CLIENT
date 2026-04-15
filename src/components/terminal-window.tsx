import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import "./terminal-window.css";
import type { RuntimeMember } from "../data/mock-runtime";

type TerminalWindowProps = {
  apiKey?: string;
  apiKeyEnabled?: boolean;
  bridgePort?: number;
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
  bridgePort = 4281,
  member,
  onClose,
  terminalFontSize = 13,
}: TerminalWindowProps) {
  const activeCursorColor = "#F8FAFC";
  const [connectionState, setConnectionState] =
    useState<BridgeConnectionState>("connecting");
  const [connectionLabel, setConnectionLabel] = useState("连接本地 bridge...");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const inputCursorTimerRef = useRef<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

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

    return `ws://127.0.0.1:${bridgePort}/terminal?${params.toString()}`;
  }, [apiKey, apiKeyEnabled, bridgePort, member?.id, member?.shell, member?.workspace]);

  const runtimeShellLabel = member?.runtimeInfo?.resolvedShell ?? member?.shell ?? "";
  const memberName = member?.name ?? "";

  useEffect(() => {
    if (!member || !containerRef.current) {
      return;
    }

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

    const handleTerminalInput = terminal.onData((data) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }

      showCursorTemporarily();
      socket.send(
        JSON.stringify({
          type: "input",
          data,
        }),
      );
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
        setCursorMuted(true);
        terminal.write(payload.data);
        return;
      }

      if (payload.type === "meta") {
        setCursorMuted(true);
        terminal.writeln(`\r\n${payload.data}`);
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
          <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-content/60">
            <span className="badge badge-outline border-neutral-content/15 text-neutral-content/70">
              直接在终端区域输入
            </span>
            <span>Enter 执行命令</span>
            <span>Ctrl+C 中断</span>
            <span>Ctrl+V / 右键粘贴</span>
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
