import type { NodeProps } from "@xyflow/react";
import type {
  RuntimeFlowNode,
  RuntimeStatus,
} from "../data/mock-runtime";

const runtimeStatusMap: Record<
  RuntimeStatus,
  { badge: string; text: string }
> = {
  running: {
    badge: "badge-success",
    text: "运行中",
  },
  stopped: {
    badge: "badge-outline",
    text: "已停止",
  },
  error: {
    badge: "badge-error",
    text: "异常",
  },
};

export function RuntimeNode({ data, selected }: NodeProps<RuntimeFlowNode>) {
  const stateStyle = runtimeStatusMap[data.runtimeStatus];
  const runtimeShellLabel = data.runtimeInfo?.resolvedShell ?? data.shell;
  const taskTitle = data.currentTask && data.currentTask.trim() ? data.currentTask.trim() : "暂无";
  const normalizedNextAction = data.nextAction && data.nextAction.trim() ? data.nextAction.trim() : "";
  const nextStep =
    !normalizedNextAction ||
    /继续当前工作空间任务|等待启动 CLI|等待重新启动 CLI|开始执行新分配任务/.test(normalizedNextAction)
      ? "暂无"
      : normalizedNextAction;
  const recentLine = data.recentCompleted
    ? {
        label: "最近完成",
        value: data.recentCompleted,
      }
    : data.recentArtifact
      ? {
          label: "最近交付物",
          value: data.recentArtifact,
        }
      : null;
  const taskMetaParts = [
    data.taskPriority === "P0" ? data.taskPriority : null,
    data.taskDeadline ? `截止 ${data.taskDeadline}` : null,
  ].filter(Boolean);
  const inspectorTone =
    data.inspector?.autoPilotDecision === "auto_replied"
      ? "badge-info"
      : data.inspector?.taskState === "waiting_feedback"
      ? "badge-success"
      : data.inspector?.taskState === "blocked"
        ? "badge-warning"
        : data.inspector?.replyCandidate?.suggestedReply
          ? "badge-info"
          : "";
  const inspectorLabel =
    data.inspector?.autoPilotDecision === "auto_replied"
      ? "已自动回复"
      : (data.inspector?.missingTargetFiles?.length || 0) > 0
        ? "缺目标文件"
      : data.inspector?.taskState === "waiting_feedback"
      ? "建议验收"
      : data.inspector?.taskState === "blocked"
        ? "需关注"
        : data.inspector?.replyCandidate?.suggestedReply
          ? "可建议回复"
          : "";

  return (
    <div
      className={`card w-[360px] border border-base-300 bg-base-100 p-4 shadow-sm transition ${
        selected
          ? "ring-2 ring-primary/40"
          : "hover:border-base-300"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[15px] font-semibold text-shell-text">{data.name}</p>
            <span className="badge badge-outline badge-sm rounded-md">{data.company}</span>
          </div>
          <p className="mt-1 text-xs text-shell-muted">
            {data.role} · {data.employeeCode}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <span className={`badge badge-outline rounded-md whitespace-nowrap text-[11px] font-semibold ${stateStyle.badge}`}>
            {stateStyle.text}
          </span>
        </div>
      </div>

      <p className="mt-3 text-xs text-sky-300">
        {runtimeShellLabel} · {data.permission}
      </p>

      {taskMetaParts.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          {taskMetaParts.map((part) => (
            <span key={part} className="badge badge-outline rounded-md">
              {part}
            </span>
          ))}
          {inspectorLabel ? <span className={`badge badge-outline rounded-md ${inspectorTone}`}>{inspectorLabel}</span> : null}
        </div>
      ) : null}

      <div className="card mt-3 border border-base-300 bg-base-200 px-3 py-3 shadow-none">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-shell-muted">
          任务
        </p>
        <p className="mt-2 text-sm text-shell-text">{taskTitle}</p>
        <p className="mt-2 text-xs text-sky-300">下一步：{nextStep}</p>
      </div>

      {recentLine ? (
        <div className="mt-3 space-y-1 text-[11px] text-shell-muted">
          {recentLine ? (
            <p>
              <span className="font-semibold text-shell-text">{recentLine.label}：</span>
              <span>{recentLine.value}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
