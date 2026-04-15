import { useEffect, useMemo, useState } from "react";
import {
  elevationModeOptions,
  permissionOptions,
  promptAutomationOptions,
} from "../data/mock-runtime";
import type {
  AgentStatus,
  RuntimeMember,
  RuntimeStatus,
  TaskIntakeStatus,
  WorkStatus,
} from "../data/mock-runtime";

type DeliveryHistoryEntry = {
  detail: string;
  filePath: string | null;
  folderPath: string;
  id: string;
  kind: "artifact" | "finished";
  modifiedAt: string | null;
  projectName?: string | null;
  title: string;
  workspacePath?: string | null;
};

type MergedHistoryEntry = {
  detail: string;
  filePath: string | null;
  folderPath: string;
  id: string;
  kind: "artifact" | "finished" | "merged";
  modifiedAt: string | null;
  projectName?: string | null;
  title: string;
  workspacePath?: string | null;
};

type ProjectSpaceEntry = {
  currentTask: string;
  isCurrent: boolean;
  nextAction: string;
  projectName: string;
  queued: boolean;
  status: string;
  updatedAt: string | null;
  workspacePath: string;
};

const statusToneMap: Record<RuntimeStatus, { chip: string; text: string }> = {
  running: {
    chip: "badge-success",
    text: "运行中",
  },
  stopped: {
    chip: "badge-outline",
    text: "已停止",
  },
  error: {
    chip: "badge-error",
    text: "异常",
  },
} as const;

const workToneMap: Record<WorkStatus, { chip: string; text: string }> = {
  idle: {
    chip: "badge-ghost",
    text: "待派单",
  },
  busy: {
    chip: "badge-info",
    text: "执行中",
  },
  blocked: {
    chip: "badge-warning",
    text: "阻塞中",
  },
};

const agentStatusMap: Record<AgentStatus, string> = {
  matched: "已匹配",
  mismatched: "不匹配",
  unverified: "待校验",
};

const intakeStatusMap: Record<
  Exclude<TaskIntakeStatus, "none">,
  { chip: string; text: string }
> = {
  pending_ack: {
    chip: "badge-warning",
    text: "待接单",
  },
  confirming: {
    chip: "badge-secondary",
    text: "确认中",
  },
  confirm_failed: {
    chip: "badge-error",
    text: "确认失败",
  },
  acknowledged: {
    chip: "badge-info",
    text: "已接单",
  },
  planned: {
    chip: "badge-success",
    text: "已排计划",
  },
};

function extractArtifactReferences(detail: string) {
  return Array.from(String(detail).matchAll(/artifacts\/([^\s`，,]+)/gi))
    .map((match) => match[1]?.trim() ?? "")
    .filter((value): value is string => Boolean(value));
}

function normalizeFinishedTitle(detail: string) {
  return detail
    .replace(/^- /, "")
    .replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s+/, "")
    .trim();
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function buildRuntimeSummary(member: RuntimeMember) {
  if (member.runtimeStatus === "error") {
    return "会话异常，建议先查看阻塞原因，再决定是否重启。";
  }

  if (member.runtimeStatus === "stopped") {
    if (member.recoveryPending) {
      return "Codex 会话已中断，当前工作空间可在重启后继续恢复。";
    }
    if (member.currentTask !== "暂无") {
      return "会话当前未运行，但任务上下文仍保留在工作空间中。";
    }
    return "会话当前未运行，等待手动启动或新的任务指派。";
  }

  if (member.taskIntakeStatus === "pending_ack") {
    return "已收到新任务，正在等待员工确认并生成计划。";
  }
  if (member.taskIntakeStatus === "confirming") {
    return "员工正在读取任务上下文并回写首轮确认。";
  }
  if (member.taskIntakeStatus === "confirm_failed") {
    return "任务确认未成功，建议重试接单确认或进入终端排查。";
  }
  if (member.taskIntakeStatus === "planned") {
    return "员工已完成任务拆解，接下来会按计划持续推进。";
  }
  if (member.workStatus === "blocked") {
    return "会话仍在运行，但当前任务处于阻塞状态，需要人工关注。";
  }
  if (member.currentTask === "暂无") {
    return "Codex 会话运行中，当前没有执行中的任务，可直接派单。";
  }

  return "Codex 会话运行中，正在处理当前任务。";
}

function formatRuntimeAction(value: string | null | undefined) {
  switch (value) {
    case "start":
      return "启动会话";
    case "restart":
      return "重启会话";
    case "stop":
      return "停止会话";
    case "assign_task":
      return "收到新任务";
    case "complete_task":
      return "归档任务";
    default:
      return value || "暂无";
  }
}

function buildIdleTaskSummary(member: RuntimeMember, queueCount: number) {
  if (queueCount > 0) {
    return "当前没有执行中的任务，可从下方排队任务继续接续。";
  }
  if (member.recoveryPending) {
    return "当前没有执行中的任务，重启后可继续恢复这个工作空间。";
  }
  if (member.runtimeStatus === "running") {
    return "当前没有执行中的任务，可直接派发新任务。";
  }
  return "当前没有执行中的任务。";
}

type RuntimeDetailModalProps = {
  canEnterTerminal: boolean;
  historyArtifacts: DeliveryHistoryEntry[];
  historyFinished: DeliveryHistoryEntry[];
  historyLoading: boolean;
  isRestarting: boolean;
  member: RuntimeMember | null;
  projectSpaces: ProjectSpaceEntry[];
  projectSpacesLoading: boolean;
  onClose: () => void;
  onOpenAgentFile: (memberId: string) => void;
  onOpenHistoryFile: (filePath: string) => void;
  onOpenHistoryFolder: (folderPath: string) => void;
  onOpenPlanFile: (memberId: string) => void;
  onOpenRestoreSummaryFile: (memberId: string) => void;
  onOpenStartupAckFile: (memberId: string) => void;
  onOpenTaskRequestFile: (memberId: string) => void;
  onOpenWorkspaceGuideFile: (memberId: string) => void;
  onCopySessionId: (memberId: string) => void;
  onCopyWorkspace: (memberId: string) => void;
  onEnterTerminal: (memberId: string) => void;
  onOpenProjectWorkspace: (workspacePath: string) => void;
  onOpenWorkspace: (memberId: string) => void;
  onSwitchProjectSpace: (memberId: string, workspacePath: string) => void;
  onCompleteTask: (memberId: string) => void;
  onRetryStartupAck: (memberId: string) => void;
  onRestartRuntime: (memberId: string) => void;
  onStopRuntime: (memberId: string) => void;
  onUpdateMemberSettings: (
    memberId: string,
    settings: {
      autoTrustWorkspace: boolean;
      elevationMode: RuntimeMember["automationSettings"]["elevationMode"];
      permission: string;
      promptAutomation: RuntimeMember["automationSettings"]["promptAutomation"];
    },
  ) => void;
};

export function RuntimeDetailModal({
  canEnterTerminal,
  historyArtifacts,
  historyFinished,
  historyLoading,
  isRestarting,
  member,
  projectSpaces,
  projectSpacesLoading,
  onClose,
  onOpenAgentFile,
  onOpenHistoryFile,
  onOpenHistoryFolder,
  onOpenPlanFile,
  onOpenRestoreSummaryFile,
  onOpenStartupAckFile,
  onOpenTaskRequestFile,
  onOpenWorkspaceGuideFile,
  onCopySessionId,
  onCopyWorkspace,
  onEnterTerminal,
  onOpenProjectWorkspace,
  onOpenWorkspace,
  onSwitchProjectSpace,
  onCompleteTask,
  onRetryStartupAck,
  onRestartRuntime,
  onStopRuntime,
  onUpdateMemberSettings,
}: RuntimeDetailModalProps) {
  const [activeTab, setActiveTab] = useState<"info" | "runtime" | "history" | "projects">("info");
  const [historyProjectFilter, setHistoryProjectFilter] = useState("all");
  const [permissionDraft, setPermissionDraft] = useState("受限模式");
  const [promptAutomationDraft, setPromptAutomationDraft] = useState<RuntimeMember["automationSettings"]["promptAutomation"]>("safe_auto");
  const [elevationDraft, setElevationDraft] = useState<RuntimeMember["automationSettings"]["elevationMode"]>("manual");
  const [autoTrustDraft, setAutoTrustDraft] = useState(true);

  useEffect(() => {
    setActiveTab("info");
    setHistoryProjectFilter("all");
  }, [member?.id]);

  useEffect(() => {
    if (!member) {
      return;
    }

    setPermissionDraft(member.permission);
    setPromptAutomationDraft(member.automationSettings.promptAutomation);
    setElevationDraft(member.automationSettings.elevationMode);
    setAutoTrustDraft(member.automationSettings.autoTrustWorkspace);
  }, [member]);

  const mergedHistory = useMemo<MergedHistoryEntry[]>(() => {
    const artifactMap = new Map<string, DeliveryHistoryEntry>();
    for (const artifact of historyArtifacts) {
      artifactMap.set(artifact.detail, artifact);
    }

    const merged: MergedHistoryEntry[] = [];
    const consumedArtifactKeys = new Set<string>();

    for (const finished of historyFinished) {
      const artifactRefs = extractArtifactReferences(finished.detail);
      const linkedArtifacts = artifactRefs
        .map((artifactRef) => artifactMap.get(artifactRef))
        .filter((artifact): artifact is DeliveryHistoryEntry => Boolean(artifact));
      const linkedArtifact: DeliveryHistoryEntry | null = linkedArtifacts[0] ?? null;

      if (linkedArtifact) {
        for (const artifact of linkedArtifacts) {
          consumedArtifactKeys.add(artifact.detail);
        }
        merged.push({
          detail: finished.detail,
          filePath: linkedArtifact.filePath,
          folderPath: linkedArtifact.folderPath,
          id: `merged:${finished.id}:${linkedArtifact.id}`,
          kind: "merged",
          modifiedAt: linkedArtifact.modifiedAt,
          projectName: linkedArtifact.projectName ?? finished.projectName,
          title: finished.title || normalizeFinishedTitle(finished.detail),
          workspacePath: linkedArtifact.workspacePath ?? finished.workspacePath,
        });
        continue;
      }

      merged.push({
        detail: finished.detail,
        filePath: null,
        folderPath: finished.folderPath,
        id: finished.id,
        kind: "finished",
        modifiedAt: null,
        projectName: finished.projectName,
        title: finished.title || normalizeFinishedTitle(finished.detail),
        workspacePath: finished.workspacePath,
      });
    }

    for (const artifact of historyArtifacts) {
      if (consumedArtifactKeys.has(artifact.detail)) {
        continue;
      }

      merged.push({
        detail: artifact.detail,
        filePath: artifact.filePath,
        folderPath: artifact.folderPath,
        id: artifact.id,
        kind: "artifact",
        modifiedAt: artifact.modifiedAt,
        projectName: artifact.projectName,
        title: artifact.title,
        workspacePath: artifact.workspacePath,
      });
    }

    return merged.sort((left, right) => {
      const leftTime = left.modifiedAt ?? "";
      const rightTime = right.modifiedAt ?? "";
      return rightTime.localeCompare(leftTime);
    });
  }, [historyArtifacts, historyFinished]);

  const groupedHistory = useMemo(
    () =>
      mergedHistory.reduce<Array<{ entries: MergedHistoryEntry[]; projectName: string }>>(
        (result, entry) => {
          const projectName = entry.projectName || "未命名项目";
          const existing = result.find((group) => group.projectName === projectName);
          if (existing) {
            existing.entries.push(entry);
            return result;
          }

          return [
            ...result,
            {
              entries: [entry],
              projectName,
            },
          ];
        },
        [],
      ),
    [mergedHistory],
  );
  const availableHistoryProjects = useMemo(
    () => groupedHistory.map((group) => group.projectName),
    [groupedHistory],
  );
  const filteredGroupedHistory = useMemo(
    () =>
      historyProjectFilter === "all"
        ? groupedHistory
        : groupedHistory.filter((group) => group.projectName === historyProjectFilter),
    [groupedHistory, historyProjectFilter],
  );

  if (!member) {
    return null;
  }

  const tone = statusToneMap[member.runtimeStatus];
  const workTone = workToneMap[member.workStatus];
  const agentStatusLabel = agentStatusMap[member.agentStatus];
  const runtimeShellLabel = member.runtimeInfo?.resolvedShell ?? member.shell;
  const intakeTone =
    member.taskIntakeStatus !== "none" ? intakeStatusMap[member.taskIntakeStatus] : null;
  const queueCount = member.taskQueue.length;
  const runtimeStartedAt = formatDateTime(member.runtimeInfo?.startedAt);
  const runtimeStoppedAt = formatDateTime(member.runtimeInfo?.stoppedAt);
  const lastActionLabel = formatRuntimeAction(member.runtimeInfo?.lastAction);
  const runtimeSummary = buildRuntimeSummary(member);
  const queuePreview = member.taskQueue.slice(0, 2);
  const hiddenQueueCount = Math.max(queueCount - queuePreview.length, 0);
  const showWorkBadge = member.runtimeStatus !== "stopped";
  const hasActiveTask = member.currentTask !== "暂无";
  const hasNextAction = member.nextAction !== "暂无";
  const showTaskMeta =
    hasActiveTask && Boolean(member.taskPriority || member.taskDeadline || member.taskSource || member.taskTimeWindow);
  const idleTaskSummary = buildIdleTaskSummary(member, queueCount);
  const visibleDiagnostics = member.diagnostics.filter(
    (line) =>
      !line.startsWith("session ") &&
      !line.startsWith("pid ") &&
      !line.startsWith("shell ") &&
      line !== "恢复状态正常",
  );
  const latestDiagnostic = visibleDiagnostics[0] ?? "";
  const moreDiagnostics = visibleDiagnostics.slice(1);
  const hasLiveSession = Boolean(member.runtimeInfo?.sessionId);
  const sessionLabel = hasLiveSession ? member.runtimeInfo?.sessionId ?? "-" : "无活动会话";
  const pidLabel =
    typeof member.runtimeInfo?.pid === "number" ? String(member.runtimeInfo.pid) : "无活动进程";

  return (
    <dialog open className="modal z-40 bg-[#020617]/72 backdrop-blur-sm">
      <div className="modal-box flex h-[82vh] max-h-[780px] max-w-[760px] flex-col overflow-hidden p-0">
        <div className="shrink-0 border-b border-base-300 px-5 py-4">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-[18px] font-semibold text-shell-text">{member.name}</p>
              <p className="mt-1 text-xs text-shell-muted">
                {runtimeShellLabel} · {member.permission} · {member.role} · {member.employeeCode}
              </p>
            </div>
            <button
              className="btn btn-ghost btn-xs ml-auto"
              onClick={onClose}
              type="button"
            >
              关闭
            </button>
          </div>

          <div className="tabs tabs-boxed mt-4 w-fit gap-2 bg-base-200 p-1">
            <button
              className={`tab ${activeTab === "info" ? "tab-active" : ""}`}
              onClick={() => setActiveTab("info")}
              type="button"
            >
              员工信息
            </button>
            <button
              className={`tab ${activeTab === "runtime" ? "tab-active" : ""}`}
              onClick={() => setActiveTab("runtime")}
              type="button"
            >
              运行情况
            </button>
            <button
              className={`tab ${activeTab === "history" ? "tab-active" : ""}`}
              onClick={() => setActiveTab("history")}
              type="button"
            >
              工作成果
            </button>
            <button
              className={`tab ${activeTab === "projects" ? "tab-active" : ""}`}
              onClick={() => setActiveTab("projects")}
              type="button"
            >
              项目空间
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {activeTab === "info" ? (
            <div className="space-y-4">
              <section className="card bg-base-200 p-4 shadow-none">
                <p className="text-xs uppercase tracking-[0.18em] text-shell-muted">身份档案</p>
                <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                  <div className="card bg-base-100 px-3 py-3 shadow-none">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">公司</p>
                    <p className="mt-2 text-sm text-shell-text">{member.company}</p>
                  </div>
                  <div className="card bg-base-100 px-3 py-3 shadow-none">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">部门</p>
                    <p className="mt-2 text-sm text-shell-text">{member.department}</p>
                  </div>
                  <div className="card bg-base-100 px-3 py-3 shadow-none">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">岗位</p>
                    <p className="mt-2 text-sm text-shell-text">{member.role}</p>
                  </div>
                  <div className="card bg-base-100 px-3 py-3 shadow-none">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">员工编号</p>
                    <p className="mt-2 text-sm text-shell-text">{member.employeeCode}</p>
                  </div>
                  <div className="card bg-base-100 px-3 py-3 shadow-none">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">运行引擎</p>
                    <p className="mt-2 text-sm text-shell-text">{runtimeShellLabel}</p>
                  </div>
                  <div className="card bg-base-100 px-3 py-3 shadow-none">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">权限</p>
                    <p className="mt-2 text-sm text-shell-text">{member.permission}</p>
                  </div>
                </div>
              </section>

              <section className="card bg-base-200 p-4 shadow-none">
                <p className="text-xs uppercase tracking-[0.18em] text-shell-muted">当前空间</p>
                <div className="mt-4 space-y-3">
                  <div className="card bg-base-100 px-3 py-3 shadow-none">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">当前项目</p>
                    <p className="mt-2 text-sm text-shell-text">{member.projectName}</p>
                  </div>
                  <div className="card bg-base-100 px-3 py-3 shadow-none">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">工作空间路径</p>
                    <p className="mt-2 break-all text-sm leading-6 text-shell-text">{member.workspace}</p>
                  </div>
                  <div className="card bg-base-100 px-3 py-3 shadow-none">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">Agent 来源</p>
                    <p className="mt-2 break-all text-sm leading-6 text-shell-text">{member.repoSource}</p>
                  </div>
                </div>
              </section>

              <section className="card bg-base-200 p-4 shadow-none">
                <p className="text-xs uppercase tracking-[0.18em] text-shell-muted">常用入口</p>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div className="card bg-base-100 p-3 shadow-none">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">工作空间</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button className="btn btn-outline btn-sm" onClick={() => onOpenWorkspace(member.id)} type="button">
                        打开工作空间
                      </button>
                      <button className="btn btn-outline btn-sm" onClick={() => onCopyWorkspace(member.id)} type="button">
                        复制路径
                      </button>
                    </div>
                  </div>
                  <div className="card bg-base-100 p-3 shadow-none">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">任务入口</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button className="btn btn-outline btn-sm" onClick={() => onOpenTaskRequestFile(member.id)} type="button">
                        task_request.md
                      </button>
                      <button className="btn btn-outline btn-sm" onClick={() => onOpenStartupAckFile(member.id)} type="button">
                        startup_ack.md
                      </button>
                      <button className="btn btn-outline btn-sm" onClick={() => onOpenPlanFile(member.id)} type="button">
                        plan.md
                      </button>
                    </div>
                  </div>
                  <div className="card bg-base-100 p-3 shadow-none">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">上下文资料</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button className="btn btn-outline btn-sm" onClick={() => onOpenAgentFile(member.id)} type="button">
                        agent.md
                      </button>
                      <button className="btn btn-outline btn-sm" onClick={() => onOpenWorkspaceGuideFile(member.id)} type="button">
                        workspace_guide.md
                      </button>
                      <button className="btn btn-outline btn-sm" onClick={() => onOpenRestoreSummaryFile(member.id)} type="button">
                        restore_summary.md
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <section className="card bg-base-200 p-4 shadow-none">
                <p className="text-xs uppercase tracking-[0.18em] text-shell-muted">运行策略</p>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <label className="form-control gap-2">
                    <span className="label-text text-[13px] font-bold text-shell-text">权限模式</span>
                    <select
                      className="select select-bordered bg-base-100"
                      onChange={(event) => setPermissionDraft(event.target.value)}
                      value={permissionDraft}
                    >
                      {permissionOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="form-control gap-2">
                    <span className="label-text text-[13px] font-bold text-shell-text">提示自动化</span>
                    <select
                      className="select select-bordered bg-base-100"
                      onChange={(event) =>
                        setPromptAutomationDraft(
                          event.target.value as RuntimeMember["automationSettings"]["promptAutomation"],
                        )
                      }
                      value={promptAutomationDraft}
                    >
                      {promptAutomationOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="form-control gap-2">
                    <span className="label-text text-[13px] font-bold text-shell-text">提权处理</span>
                    <select
                      className="select select-bordered bg-base-100"
                      onChange={(event) =>
                        setElevationDraft(
                          event.target.value as RuntimeMember["automationSettings"]["elevationMode"],
                        )
                      }
                      value={elevationDraft}
                    >
                      {elevationModeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="label cursor-pointer justify-start gap-3 rounded-box border border-base-300 bg-base-100 px-4 py-3">
                    <input
                      checked={autoTrustDraft}
                      className="toggle toggle-primary"
                      onChange={(event) => setAutoTrustDraft(event.target.checked)}
                      type="checkbox"
                    />
                    <span className="label-text">
                      自动信任工作空间
                      <span className="ml-2 text-xs text-base-content/60">
                        仅处理 Codex 的固定信任提示
                      </span>
                    </span>
                  </label>
                </div>
                <div className="mt-4 flex items-center justify-between gap-4">
                  <p className="text-xs text-shell-muted">
                    自动化策略会立即生效；权限模式在下次重启 CLI 后生效。
                  </p>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() =>
                      onUpdateMemberSettings(member.id, {
                        autoTrustWorkspace: autoTrustDraft,
                        elevationMode: elevationDraft,
                        permission: permissionDraft,
                        promptAutomation: promptAutomationDraft,
                      })
                    }
                    type="button"
                  >
                    保存策略
                  </button>
                </div>
              </section>
            </div>
          ) : null}

          {activeTab === "runtime" ? (
            <div className="space-y-4">
              <section className="card bg-base-200 p-4 shadow-none">
                <p className="text-xs uppercase tracking-[0.18em] text-shell-muted">会话摘要</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className={`badge badge-outline ${tone.chip}`}>{tone.text}</span>
                  {showWorkBadge ? (
                    <span className={`badge badge-outline ${workTone.chip}`}>{workTone.text}</span>
                  ) : null}
                  {intakeTone ? (
                    <span className={`badge badge-outline ${intakeTone.chip}`}>{intakeTone.text}</span>
                  ) : null}
                  {member.recoveryPending ? (
                    <span className="badge badge-secondary badge-outline">待恢复</span>
                  ) : null}
                </div>
                <p className="mt-4 text-sm leading-6 text-shell-text">{runtimeSummary}</p>
                <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                  <div className="card bg-base-100 px-3 py-3 shadow-none">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">心跳</p>
                    <p className="mt-2 text-sm text-shell-text">{member.heartbeatLabel}</p>
                  </div>
                  <div className="card bg-base-100 px-3 py-3 shadow-none">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">最近动作</p>
                    <p className="mt-2 text-sm text-shell-text">{lastActionLabel}</p>
                  </div>
                </div>
                {(member.taskIntakeStatus === "pending_ack" || member.taskIntakeStatus === "confirm_failed") ? (
                  <div className="mt-3">
                    <button className="btn btn-outline btn-xs" onClick={() => onRetryStartupAck(member.id)} type="button">
                      重试接单确认
                    </button>
                  </div>
                ) : null}
              </section>

              <section className="card bg-base-200 p-4 shadow-none">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs uppercase tracking-[0.18em] text-shell-muted">当前任务</p>
                  <span className="badge badge-outline badge-sm rounded-md">
                    {queueCount > 0 ? `排队 ${queueCount}` : "无排队"}
                  </span>
                </div>
                {showTaskMeta ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-shell-muted">
                    {member.taskPriority ? <span className="badge badge-outline">{member.taskPriority}</span> : null}
                    {member.taskTimeWindow ? <span className="badge badge-outline">窗口：{member.taskTimeWindow}</span> : null}
                    {member.taskDeadline ? <span className="badge badge-outline">截止：{member.taskDeadline}</span> : null}
                    {member.taskSource ? <span className="badge badge-outline">来源：{member.taskSource}</span> : null}
                  </div>
                ) : null}
                {hasActiveTask ? (
                  <>
                    <p className="mt-3 text-sm leading-6 text-shell-text">{member.currentTask}</p>
                    {hasNextAction ? (
                      <p className="mt-3 text-sm text-sky-300">下一步：{member.nextAction}</p>
                    ) : null}
                  </>
                ) : (
                  <div className="mt-3 card bg-base-100 px-4 py-3 text-sm text-shell-muted shadow-none">
                    {idleTaskSummary}
                  </div>
                )}
                <div className="mt-4 space-y-2">
                  <p className="text-xs uppercase tracking-[0.18em] text-shell-muted">排队任务</p>
                  {queueCount === 0 ? (
                    <div className="card bg-base-100 px-3 py-2 text-sm text-shell-muted shadow-none">
                      暂无排队任务
                    </div>
                  ) : (
                    queuePreview.map((task) => (
                      <div
                        key={task}
                        className="card bg-base-100 px-3 py-2 text-sm text-shell-text shadow-none"
                      >
                        {task}
                      </div>
                    ))
                  )}
                  {hiddenQueueCount > 0 ? (
                    <p className="text-xs text-shell-muted">另有 {hiddenQueueCount} 项排队任务，可在后续继续查看。</p>
                  ) : null}
                </div>
              </section>

              <section className="card bg-base-200 p-4 shadow-none">
                <p className="text-xs uppercase tracking-[0.18em] text-shell-muted">风险与阻塞</p>
                <div className="mt-3 space-y-2">
                  {member.blockedTasks.length > 0 ? (
                    member.blockedTasks.map((line) => (
                      <div key={line} className="card bg-warning/10 px-3 py-2 text-sm text-warning shadow-none">
                        {line}
                      </div>
                    ))
                  ) : latestDiagnostic ? (
                    <div className="card bg-base-100 px-3 py-3 text-sm text-shell-text shadow-none">
                      {latestDiagnostic}
                    </div>
                  ) : (
                    <div className="card bg-base-100 px-3 py-3 text-sm text-shell-muted shadow-none">
                      暂无阻塞，运行正常。
                    </div>
                  )}
                  {moreDiagnostics.length > 0 ? (
                    <div className="collapse collapse-arrow bg-base-100">
                      <input type="checkbox" />
                      <div className="collapse-title px-3 py-2 text-sm font-medium text-shell-text">
                        查看更多诊断
                      </div>
                      <div className="collapse-content space-y-2 px-3 pb-3">
                        {moreDiagnostics.map((line) => (
                          <div key={line} className="text-sm text-shell-muted">
                            {line}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>

              <section>
                <div className="collapse collapse-arrow border border-base-300 bg-base-200">
                  <input type="checkbox" />
                  <div className="collapse-title text-xs uppercase tracking-[0.18em] text-shell-muted">
                    技术详情
                  </div>
                  <div className="collapse-content">
                    <div className="grid gap-3 text-sm md:grid-cols-2">
                      <div className="card bg-base-100 px-3 py-3 shadow-none">
                        <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">Shell</p>
                        <p className="mt-2 break-all text-sm text-shell-text">{runtimeShellLabel}</p>
                      </div>
                      <div className="card bg-base-100 px-3 py-3 shadow-none">
                        <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">Agent 校验</p>
                        <p className="mt-2 text-sm text-shell-text">{agentStatusLabel}</p>
                      </div>
                      <div className="card bg-base-100 px-3 py-3 shadow-none">
                        <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">Session</p>
                        <p className="mt-2 break-all text-sm text-shell-text">
                          {sessionLabel}
                        </p>
                      </div>
                      <div className="card bg-base-100 px-3 py-3 shadow-none">
                        <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">PID</p>
                        <p className="mt-2 text-sm text-shell-text">{pidLabel}</p>
                      </div>
                      <div className="card bg-base-100 px-3 py-3 shadow-none">
                        <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">启动时间</p>
                        <p className="mt-2 text-sm text-shell-text">{runtimeStartedAt}</p>
                      </div>
                      <div className="card bg-base-100 px-3 py-3 shadow-none">
                        <p className="text-[11px] uppercase tracking-[0.16em] text-shell-muted">停止时间</p>
                        <p className="mt-2 text-sm text-shell-text">{runtimeStoppedAt}</p>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        className="btn btn-outline btn-sm"
                        disabled={!hasLiveSession}
                        onClick={() => onCopySessionId(member.id)}
                        type="button"
                      >
                        复制 sessionId
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          ) : null}

          {activeTab === "history" ? (
            <div className="space-y-4">
              <section className="card bg-base-200 p-4 shadow-none">
                <p className="text-xs uppercase tracking-[0.18em] text-shell-muted">工作成果</p>
                <p className="mt-2 text-xs text-shell-muted">
                  展示当前员工在不同项目下的聚合成果，文件仍保留在各自项目工作空间中。
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    className={`btn btn-xs ${historyProjectFilter === "all" ? "btn-primary" : "btn-outline"}`}
                    onClick={() => setHistoryProjectFilter("all")}
                    type="button"
                  >
                    全部项目
                  </button>
                  {member.projectName ? (
                    <button
                      className={`btn btn-xs ${historyProjectFilter === member.projectName ? "btn-primary" : "btn-outline"}`}
                      onClick={() => setHistoryProjectFilter(member.projectName)}
                      type="button"
                    >
                      当前项目
                    </button>
                  ) : null}
                  {availableHistoryProjects
                    .filter((projectName) => projectName !== member.projectName)
                    .map((projectName) => (
                      <button
                        key={projectName}
                        className={`btn btn-xs ${historyProjectFilter === projectName ? "btn-primary" : "btn-outline"}`}
                        onClick={() => setHistoryProjectFilter(projectName)}
                        type="button"
                      >
                        {projectName}
                      </button>
                    ))}
                </div>
                {historyLoading ? (
                  <div className="mt-3 space-y-2 text-sm text-shell-muted">
                    <p>正在加载工作成果...</p>
                  </div>
                ) : filteredGroupedHistory.length === 0 ? (
                  <div className="mt-3 card bg-base-100 px-3 py-3 text-sm text-shell-muted shadow-none">
                    暂无工作成果
                  </div>
                ) : (
                  <div className="mt-3 space-y-4">
                    {filteredGroupedHistory.map((group) => (
                      <section key={group.projectName} className="space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="badge badge-outline rounded-md">{group.projectName}</span>
                          <span className="text-xs text-shell-muted">
                            {group.entries.length} 项成果
                          </span>
                        </div>
                        <div className="space-y-3">
                          {group.entries.map((entry) => (
                            <div key={entry.id} className="card bg-base-100 p-3 shadow-none">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="truncate text-sm font-semibold text-shell-text">{entry.title}</p>
                                    <span className="badge badge-outline badge-sm rounded-md">
                                      {entry.kind === "merged"
                                        ? "已交付"
                                        : entry.kind === "artifact"
                                          ? "交付物"
                                          : "完成记录"}
                                    </span>
                                  </div>
                                  <p className="mt-1 break-all text-xs text-shell-muted">{entry.detail}</p>
                                  {entry.modifiedAt ? (
                                    <p className="mt-1 text-xs text-shell-muted">更新时间：{entry.modifiedAt}</p>
                                  ) : null}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  {entry.filePath ? (
                                    <button className="btn btn-outline btn-xs" onClick={() => onOpenHistoryFile(entry.filePath!)} type="button">
                                      打开文件
                                    </button>
                                  ) : null}
                                  <button className="btn btn-outline btn-xs" onClick={() => onOpenHistoryFolder(entry.folderPath)} type="button">
                                    {entry.kind === "finished" ? "打开交付物文件夹" : "打开文件夹"}
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : null}

          {activeTab === "projects" ? (
            <div className="space-y-4">
              <section className="card bg-base-200 p-4 shadow-none">
                <p className="text-xs uppercase tracking-[0.18em] text-shell-muted">项目空间</p>
                <p className="mt-2 text-xs text-shell-muted">
                  展示该员工名下持有的项目工作空间，当前项目和待切换项目会优先排在前面。
                </p>
                {projectSpacesLoading ? (
                  <div className="mt-3 card bg-base-100 px-3 py-3 text-sm text-shell-muted shadow-none">
                    正在加载项目空间...
                  </div>
                ) : projectSpaces.length === 0 ? (
                  <div className="mt-3 card bg-base-100 px-3 py-3 text-sm text-shell-muted shadow-none">
                    当前没有可展示的项目空间。
                  </div>
                ) : (
                  <div className="mt-4 space-y-3">
                    {projectSpaces.map((project) => (
                      <div key={project.workspacePath} className="card bg-base-100 p-4 shadow-none">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-semibold text-shell-text">{project.projectName}</p>
                              <span className="badge badge-outline badge-sm rounded-md">{project.status}</span>
                              {project.isCurrent ? (
                                <span className="badge badge-primary badge-sm rounded-md">当前项目</span>
                              ) : null}
                            </div>
                            <p className="text-sm text-shell-text">
                              {project.currentTask === "暂无" ? "当前暂无任务" : project.currentTask}
                            </p>
                            <p className="text-xs text-sky-300">
                              下一步：{project.nextAction === "暂无" ? "暂无" : project.nextAction}
                            </p>
                            <p className="break-all text-xs text-shell-muted">{project.workspacePath}</p>
                            <p className="text-xs text-shell-muted">
                              最近更新时间：{formatDateTime(project.updatedAt)}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              className="btn btn-outline btn-xs"
                              onClick={() => onOpenProjectWorkspace(project.workspacePath)}
                              type="button"
                            >
                              打开目录
                            </button>
                            <button
                              className="btn btn-outline btn-xs"
                              onClick={() => {
                                setHistoryProjectFilter(project.projectName);
                                setActiveTab("history");
                              }}
                              type="button"
                            >
                              查看成果
                            </button>
                            {!project.isCurrent ? (
                              <button
                                className="btn btn-primary btn-xs"
                                onClick={() => onSwitchProjectSpace(member.id, project.workspacePath)}
                                type="button"
                              >
                                切到项目
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </div>

        <div className="shrink-0 border-t border-base-300 bg-base-100 px-5 py-4">
          <div className="modal-action mt-0 justify-end">
            <button
              className="btn btn-success px-4"
              disabled={member.currentTask === "暂无" || isRestarting}
              onClick={() => onCompleteTask(member.id)}
              type="button"
            >
              完成任务
            </button>
            <button className="btn btn-outline px-4" disabled={isRestarting} onClick={() => onStopRuntime(member.id)} type="button">
              停止 CLI
            </button>
            <button
              className={`btn btn-secondary px-4 ${isRestarting ? "btn-disabled" : ""}`}
              disabled={isRestarting}
              onClick={() => onRestartRuntime(member.id)}
              type="button"
            >
              {isRestarting ? "重启中..." : "重启 CLI"}
            </button>
            <button
              className="btn btn-primary px-5"
              disabled={!canEnterTerminal || isRestarting}
              onClick={() => onEnterTerminal(member.id)}
              type="button"
            >
              进入终端
            </button>
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
