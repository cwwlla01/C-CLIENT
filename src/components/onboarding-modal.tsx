import { useMemo } from "react";
import { CodexSettingsPanel } from "./codex-settings-panel";
import type {
  CodexAuthValues,
  CodexConfigValues,
  CodexSettingsState,
} from "../data/codex-config";

type OnboardingModalProps = {
  codexState: CodexSettingsState;
  hasEmployees: boolean;
  hasPublishedTask: boolean;
  onChangeAuth: (patch: Partial<CodexAuthValues>) => void;
  onChangeConfig: (patch: Partial<CodexConfigValues>) => void;
  onChangeConfigToml: (next: string) => void;
  onClose: () => void;
  onFinish: () => void;
  onOpenAddEmployee: () => void;
  onOpenPublishTask: () => void;
  onSaveCodex: () => void;
  onTestCodex: () => void;
  open: boolean;
};

export function OnboardingModal({
  codexState,
  hasEmployees,
  hasPublishedTask,
  onChangeAuth,
  onChangeConfig,
  onChangeConfigToml,
  onClose,
  onFinish,
  onOpenAddEmployee,
  onOpenPublishTask,
  onSaveCodex,
  onTestCodex,
  open,
}: OnboardingModalProps) {
  const stepItems = useMemo(
    () => [
      {
        description: "先让 Codex 在当前环境可用，员工 CLI 才能按预期启动。",
        done: codexState.configured,
        index: 1,
        title: "配置 Codex",
      },
      {
        description: "创建第一个员工，生成工作空间并写入 Agent 定义。",
        done: hasEmployees,
        index: 2,
        title: "创建员工",
      },
      {
        description: "把第一条需求投递给员工，走通接单、计划和执行链路。",
        done: hasPublishedTask,
        index: 3,
        title: "发布任务",
      },
    ],
    [codexState.configured, hasEmployees, hasPublishedTask],
  );

  const currentStep = useMemo(() => {
    const pending = stepItems.find((item) => !item.done);
    return pending?.index ?? 3;
  }, [stepItems]);

  if (!open) {
    return null;
  }

  return (
    <dialog open className="modal z-[95] bg-base-content/45 backdrop-blur-sm">
      <div className="modal-box flex h-[92vh] max-h-[960px] w-[76vw] max-w-[1180px] flex-col overflow-hidden p-0">
        <div className="shrink-0 border-b border-base-300 bg-base-100 px-6 pb-5 pt-6">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <p className="text-[28px] font-bold text-base-content">首次启动引导</p>
              <p className="max-w-[760px] text-sm text-base-content/60">
                先配置 Codex，再创建第一个员工，最后投递第一条任务。完成这三步后，客户端就能跑通一条完整的本地执行链路。
              </p>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={onClose} type="button">
              稍后再说
            </button>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {stepItems.map((item) => (
              <div
                key={item.index}
                className={`rounded-box border px-4 py-3 ${
                  item.done
                    ? "border-success/30 bg-success/10"
                    : currentStep === item.index
                      ? "border-primary/30 bg-primary/10"
                      : "border-base-300 bg-base-200"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`badge px-3 py-3 ${
                      item.done
                        ? "badge-success"
                        : currentStep === item.index
                          ? "badge-primary"
                          : "badge-outline"
                    }`}
                  >
                    {item.done ? "完成" : `步骤 ${item.index}`}
                  </span>
                  <p className="font-semibold text-base-content">{item.title}</p>
                </div>
                <p className="mt-2 text-sm text-base-content/65">{item.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="space-y-6">
            <CodexSettingsPanel
              description="先写好 config.toml 和 auth.json，并做一次 API 连通性测试。"
              onChangeAuth={onChangeAuth}
              onChangeConfig={onChangeConfig}
              onChangeConfigToml={onChangeConfigToml}
              onSave={onSaveCodex}
              onTest={onTestCodex}
              saveLabel="保存并继续"
              state={codexState}
              title="步骤 1 · Codex 配置"
            />

            <div className="grid gap-5 xl:grid-cols-2">
              <div className="card border border-base-300 bg-base-100 shadow-sm">
                <div className="card-body gap-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="card-title text-lg">步骤 2 · 创建第一个员工</h3>
                    <span className={`badge ${hasEmployees ? "badge-success" : "badge-outline"}`}>
                      {hasEmployees ? "已完成" : "待完成"}
                    </span>
                  </div>
                  <p className="text-sm text-base-content/60">
                    这里会沿用你现有的“新增员工”弹窗。创建后会自动初始化项目空间、写入 Agent 定义并尝试拉起员工 CLI。
                  </p>
                  <div className="rounded-box border border-base-300 bg-base-200 px-4 py-4 text-sm text-base-content/70">
                    <p>建议至少填写：</p>
                    <p className="mt-2">公司、部门、姓名、员工编号、Agent 定义、项目根路径。</p>
                  </div>
                  <div className="card-actions justify-end">
                    <button
                      className="btn btn-primary"
                      disabled={!codexState.configured}
                      onClick={onOpenAddEmployee}
                      type="button"
                    >
                      {hasEmployees ? "继续新增员工" : "创建第一个员工"}
                    </button>
                  </div>
                </div>
              </div>

              <div className="card border border-base-300 bg-base-100 shadow-sm">
                <div className="card-body gap-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="card-title text-lg">步骤 3 · 发布第一条任务</h3>
                    <span className={`badge ${hasPublishedTask ? "badge-success" : "badge-outline"}`}>
                      {hasPublishedTask ? "已完成" : "待完成"}
                    </span>
                  </div>
                  <p className="text-sm text-base-content/60">
                    第一个任务建议用一条短需求来验证链路，比如“先阅读 task_request.md，生成计划，再输出一个简短交付物”。
                  </p>
                  <div className="rounded-box border border-base-300 bg-base-200 px-4 py-4 text-sm text-base-content/70">
                    <p>发布后会触发：</p>
                    <p className="mt-2">任务写入、员工启动或切项目、接单确认、计划生成和执行。</p>
                  </div>
                  <div className="card-actions justify-end">
                    <button
                      className="btn btn-secondary"
                      disabled={!codexState.configured || !hasEmployees}
                      onClick={onOpenPublishTask}
                      type="button"
                    >
                      {hasPublishedTask ? "继续发布任务" : "发布第一条任务"}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {hasPublishedTask ? (
              <div className="alert alert-success">
                <span>
                  首次引导的关键路径已经走通了。后续你可以从设置页继续调整 Codex 配置，也可以继续新增员工和任务。
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="modal-action mt-0 shrink-0 justify-between gap-3 border-t border-base-300 bg-base-100 px-6 py-4">
          <p className="text-xs text-base-content/55">
            你可以稍后继续，但首次跑通建议至少完成前三步中的前两步。
          </p>
          <div className="flex gap-3">
            <button className="btn btn-outline" onClick={onClose} type="button">
              先进入调度台
            </button>
            <button
              className="btn btn-primary"
              disabled={!hasPublishedTask}
              onClick={onFinish}
              type="button"
            >
              完成引导
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
