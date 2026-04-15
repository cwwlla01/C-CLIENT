type PendingPromptItem = {
  createdAt: string;
  id: string;
  memberId: string;
  memberLabel: string;
  responseMode: "approve_reject" | "continue_only" | "notify_only";
  summary: string;
  title: string;
  workspacePath: string;
};

type PromptHandlingLogItem = {
  action: string;
  createdAt: string;
  memberId: string;
  memberLabel: string;
  mode: string;
  summary: string;
  title: string;
  workspacePath: string;
};

type PendingPromptsModalProps = {
  logs: PromptHandlingLogItem[];
  onClose: () => void;
  onEnterTerminal: (memberId: string) => void;
  onRespond: (promptId: string, action: "approve" | "reject" | "continue" | "dismiss") => void;
  open: boolean;
  prompts: PendingPromptItem[];
};

function formatPromptTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

export function PendingPromptsModal({
  logs,
  onClose,
  onEnterTerminal,
  onRespond,
  open,
  prompts,
}: PendingPromptsModalProps) {
  if (!open) {
    return null;
  }

  return (
    <dialog open className="modal z-40 bg-[#020617]/72 backdrop-blur-sm">
      <div className="modal-box flex h-[80vh] max-h-[760px] max-w-[820px] flex-col overflow-hidden p-0">
        <div className="shrink-0 border-b border-base-300 px-6 py-5">
          <div className="flex items-start gap-4">
            <div>
              <p className="text-[22px] font-semibold text-shell-text">审核消息</p>
              <p className="mt-1 text-sm text-shell-muted">
                收拢员工 CLI 的信任、继续执行和提权提示，避免逐个进终端处理。
              </p>
            </div>
            <button className="btn btn-ghost btn-sm ml-auto" onClick={onClose} type="button">
              关闭
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-5">
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-[0.18em] text-shell-muted">待审核消息</p>
                <span className="badge badge-outline">{prompts.length}</span>
              </div>

              {prompts.length === 0 ? (
                <div className="card bg-base-200 px-4 py-4 text-sm text-shell-muted shadow-none">
                  当前没有待审核消息。
                </div>
              ) : (
                <div className="space-y-4">
                  {prompts.map((prompt) => (
                    <div key={prompt.id} className="card border border-base-300 bg-base-100 shadow-none">
                      <div className="card-body gap-4 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-base font-semibold text-shell-text">{prompt.title}</p>
                              <span className="badge badge-outline badge-sm">{prompt.memberLabel}</span>
                            </div>
                            <p className="text-sm text-shell-text">{prompt.summary}</p>
                            <p className="text-xs text-shell-muted">
                              工作空间：{prompt.workspacePath}
                            </p>
                          </div>
                          <span className="text-xs text-shell-muted">
                            {formatPromptTime(prompt.createdAt)}
                          </span>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          {prompt.responseMode === "approve_reject" ? (
                            <>
                              <button
                                className="btn btn-primary btn-sm"
                                onClick={() => onRespond(prompt.id, "approve")}
                                type="button"
                              >
                                批准
                              </button>
                              <button
                                className="btn btn-outline btn-sm"
                                onClick={() => onRespond(prompt.id, "reject")}
                                type="button"
                              >
                                拒绝
                              </button>
                            </>
                          ) : null}

                          {prompt.responseMode === "continue_only" ? (
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => onRespond(prompt.id, "continue")}
                              type="button"
                            >
                              继续执行
                            </button>
                          ) : null}

                          {prompt.responseMode === "notify_only" ? (
                            <button
                              className="btn btn-outline btn-sm"
                              onClick={() => onRespond(prompt.id, "dismiss")}
                              type="button"
                            >
                              先忽略
                            </button>
                          ) : null}

                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => onEnterTerminal(prompt.memberId)}
                            type="button"
                          >
                            进入终端
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-[0.18em] text-shell-muted">最近处理</p>
                <span className="badge badge-outline">{logs.length}</span>
              </div>

              {logs.length === 0 ? (
                <div className="card bg-base-200 px-4 py-4 text-sm text-shell-muted shadow-none">
                  暂无自动处理或人工处理记录。
                </div>
              ) : (
                <div className="space-y-3">
                  {logs.map((log) => (
                    <div key={`${log.createdAt}-${log.memberId}-${log.title}`} className="card border border-base-300 bg-base-100 shadow-none">
                      <div className="card-body gap-3 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-shell-text">{log.title}</p>
                          <span className="badge badge-outline badge-sm">{log.memberLabel}</span>
                          <span className="badge badge-outline badge-sm">{log.mode}</span>
                          <span className="badge badge-outline badge-sm">{log.action}</span>
                        </div>
                        <p className="text-sm text-shell-text">{log.summary}</p>
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-shell-muted">
                          <span>{log.workspacePath}</span>
                          <span>{formatPromptTime(log.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
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
