import { useEffect, useMemo, useState } from "react";
import type { AgentDefinition } from "../data/mock-runtime";

type AgentRepoModalProps = {
  agents: AgentDefinition[];
  commit: string;
  error: string;
  loading: boolean;
  onApply: (agent: AgentDefinition) => void;
  onClose: () => void;
  onRefresh: () => void;
  open: boolean;
  repoUrl: string;
  selectedAgentId: string | null;
  warning: string;
};

export function AgentRepoModal({
  agents,
  commit,
  error,
  loading,
  onApply,
  onClose,
  onRefresh,
  open,
  repoUrl,
  selectedAgentId,
  warning,
}: AgentRepoModalProps) {
  const [keyword, setKeyword] = useState("");
  const [pendingSelection, setPendingSelection] = useState<string | null>(
    selectedAgentId,
  );

  useEffect(() => {
    setPendingSelection(selectedAgentId);
  }, [selectedAgentId]);

  const filteredAgents = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();

    if (!normalized) {
      return agents;
    }

    return agents.filter((agent) =>
      [agent.name, agent.scene, agent.description, ...agent.tags]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [agents, keyword]);

  if (!open) {
    return null;
  }

  return (
    <dialog open className="modal z-[130] bg-[#0F172A66] backdrop-blur-md">
      <div className="modal-box flex h-[78vh] max-h-[720px] max-w-[560px] flex-col overflow-hidden p-0">
        <div className="shrink-0 border-b border-base-300 px-5 pb-4 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <p className="text-[22px] font-bold text-[#111827]">Agent 仓库</p>
              <p className="text-[13px] font-medium text-[#64748B]">
                从仓库拉取 Agent 定义并应用到当前员工。
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button className="btn btn-outline btn-sm" onClick={onRefresh} type="button">
                同步仓库
              </button>
              <button
                className="btn btn-ghost btn-sm px-3"
                onClick={onClose}
                type="button"
              >
                ESC
                <span className="ml-1 text-[11px] font-bold text-[#94A3B8]">关闭</span>
              </button>
            </div>
          </div>

          <div className="mt-4 flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <p className="truncate text-[12px] text-base-content/50">{repoUrl}</p>
              <p className="text-[12px] text-base-content/40">
                当前同步：{commit ? commit.slice(0, 7) : "尚未同步"}
              </p>
            </div>
            <input
              className="input input-bordered h-[46px] w-full max-w-[280px] bg-base-100 text-base-content placeholder:text-slate-400 focus:outline-none"
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索 agent 定义、标签或场景"
              value={keyword}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="space-y-4">
            {loading ? (
              <div className="card border border-base-300 bg-base-100 shadow-none">
                <div className="card-body items-center text-center">
                  <span className="loading loading-spinner loading-md text-primary"></span>
                  <p className="text-sm text-base-content/70">
                    正在同步仓库并解析 Agent 定义...
                  </p>
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="alert alert-error">
                <span>{error}</span>
              </div>
            ) : null}

            {warning ? (
              <div className="alert alert-warning">
                <span>{warning}</span>
              </div>
            ) : null}

            <div className="space-y-3">
              {filteredAgents.map((agent) => {
                const isCurrent = agent.id === selectedAgentId;
                const isPending = agent.id === pendingSelection;

                return (
                  <div
                    key={agent.id}
                    className={`card px-4 py-4 text-left shadow-none transition ${
                      isPending
                        ? "border-primary bg-primary/5"
                        : "border-base-300 bg-base-100"
                    }`}
                  >
                    <div>
                      <p className="text-[14px] font-bold text-[#111827]">{agent.name}</p>
                      <p className="mt-1 text-[13px] font-semibold text-[#2563EB]">
                        {agent.scene}
                      </p>
                    </div>
                    <p className="mt-3 text-[13px] leading-6 text-[#64748B]">
                      {agent.description}
                    </p>
                    <div className="mt-4 flex justify-end">
                      <button
                        className={`btn btn-sm ${isPending ? "btn-primary" : "btn-outline"}`}
                        onClick={() => setPendingSelection(agent.id)}
                        type="button"
                      >
                        {isPending ? "已选择" : "选择"}
                      </button>
                    </div>
                  </div>
                );
              })}

              {!loading && !error && filteredAgents.length === 0 ? (
                <div className="card border border-base-300 bg-base-100 shadow-none">
                  <div className="card-body text-sm text-base-content/60">
                    当前仓库没有可用的 Agent 定义，或搜索结果为空。
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="modal-action mt-0 shrink-0 justify-end gap-3 border-t border-base-300 bg-base-100 px-5 py-4">
          <button className="btn btn-outline px-4" onClick={onClose} type="button">
            取消
          </button>
          <button
            className="btn btn-primary px-5"
            onClick={() => {
              const next = agents.find((agent) => agent.id === pendingSelection);
              if (next) {
                onApply(next);
              }
            }}
            type="button"
          >
            应用该定义
          </button>
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
