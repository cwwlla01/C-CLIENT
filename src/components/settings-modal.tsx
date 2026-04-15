import { useEffect, useState } from "react";
import type { DaisyThemeName } from "../data/theme-options";
import { daisyThemeOptions } from "../data/theme-options";
import {
  promptRuleActionOptions,
  type PromptRule,
} from "../data/prompt-rules";

type SettingsTab = "system" | "theme" | "rules";

export type AppSettings = {
  agentRepoUrl: string;
  autoRestoreSessions: boolean;
  defaultCompany: string;
  defaultDepartment: string;
  defaultPermission: string;
  defaultProjectStrategy: "random32" | "snowflake32" | "datetime32";
  defaultShell: string;
  directTerminalOpen: boolean;
  projectPath: string;
  terminalFontSize: number;
  theme: DaisyThemeName;
};

type SettingsModalProps = {
  apiSecurityState: {
    apiKey: string;
    enabled: boolean;
    error: string;
    filePath: string;
    saving: boolean;
  };
  onApiSecurityChange: (patch: {
    apiKey?: string;
    enabled?: boolean;
  }) => void;
  onGenerateApiKey: () => void;
  onSaveApiSecurity: () => void;
  onClose: () => void;
  onAddPromptRule: () => void;
  onDeletePromptRule: (ruleId: string) => void;
  onPromptRuleChange: (ruleId: string, patch: Partial<PromptRule>) => void;
  onSave: (next: AppSettings) => void;
  onSavePromptRules: () => void;
  onSyncRepo: () => void;
  open: boolean;
  promptRulesState: {
    error: string;
    filePath: string;
    loading: boolean;
    rules: PromptRule[];
    saving: boolean;
  };
  repoCacheRoot: string;
  repoSyncState: {
    commit: string;
    error: string;
    lastSyncedAt: string;
    loading: boolean;
    warning: string;
  };
  settings: AppSettings;
};

export function SettingsModal({
  apiSecurityState,
  onApiSecurityChange,
  onGenerateApiKey,
  onSaveApiSecurity,
  onClose,
  onAddPromptRule,
  onDeletePromptRule,
  onPromptRuleChange,
  onSave,
  onSavePromptRules,
  onSyncRepo,
  open,
  promptRulesState,
  repoCacheRoot,
  repoSyncState,
  settings,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("system");

  useEffect(() => {
    if (open) {
      setActiveTab("system");
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <dialog open className="modal z-[70] bg-base-content/30 backdrop-blur-sm">
      <div className="modal-box flex h-[86vh] max-h-[860px] w-[70vw] max-w-[70vw] flex-col overflow-hidden p-0">
        <div className="shrink-0 border-b border-base-300 px-6 pb-5 pt-6">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <p className="text-2xl font-bold text-base-content">客户端设置</p>
              <p className="text-sm text-base-content/60">
                配置项目路径、默认上下文、主题和本地客户端行为。
              </p>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={onClose} type="button">
              ESC
              <span className="ml-1 text-[11px] font-bold text-base-content/50">关闭</span>
            </button>
          </div>

          <div className="tabs tabs-boxed mt-5 w-fit gap-2 bg-base-200 p-1">
            <button
              className={`tab ${activeTab === "system" ? "tab-active" : ""}`}
              onClick={() => setActiveTab("system")}
              type="button"
            >
              系统配置
            </button>
            <button
              className={`tab ${activeTab === "theme" ? "tab-active" : ""}`}
              onClick={() => setActiveTab("theme")}
              type="button"
            >
              主题配置
            </button>
            <button
              className={`tab ${activeTab === "rules" ? "tab-active" : ""}`}
              onClick={() => setActiveTab("rules")}
              type="button"
            >
              规则配置
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-5">
            {activeTab === "system" ? (
              <div className="grid gap-5 xl:grid-cols-2">
                <div className="card border border-base-300 bg-base-100 shadow-sm">
                  <div className="card-body gap-4">
                    <h3 className="card-title text-lg">客户端上下文</h3>

                  <label className="form-control gap-2">
                    <span className="label-text font-medium">项目路径</span>
                    <input
                      className="input input-bordered"
                      onChange={(event) =>
                        onSave({ ...settings, projectPath: event.target.value })
                      }
                      placeholder="D:/PROJECT/COMPANY"
                      value={settings.projectPath}
                    />
                  </label>

                  <label className="form-control gap-2">
                    <span className="label-text font-medium">Agent 仓库地址</span>
                    <div className="join">
                      <input
                        className="input input-bordered join-item flex-1"
                        onChange={(event) =>
                          onSave({ ...settings, agentRepoUrl: event.target.value })
                        }
                        placeholder="https://github.com/jnMetaCode/agency-agents-zh"
                        value={settings.agentRepoUrl}
                      />
                      <button
                        className={`btn btn-outline join-item ${repoSyncState.loading ? "loading" : ""}`}
                        onClick={onSyncRepo}
                        type="button"
                      >
                        {repoSyncState.loading ? "同步中" : "同步仓库"}
                      </button>
                    </div>
                  </label>

                  <div className="text-xs text-base-content/50">
                    本地缓存目录：{repoCacheRoot}
                  </div>

                  {repoSyncState.commit ? (
                    <div className="text-sm text-base-content/60">
                      最近同步：{repoSyncState.commit.slice(0, 7)} · {repoSyncState.lastSyncedAt}
                    </div>
                  ) : null}

                  {repoSyncState.warning ? (
                    <div className="alert alert-warning">
                      <span>{repoSyncState.warning}</span>
                    </div>
                  ) : null}

                  {repoSyncState.error ? (
                    <div className="alert alert-error">
                      <span>{repoSyncState.error}</span>
                    </div>
                  ) : null}

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="form-control gap-2">
                      <span className="label-text font-medium">默认公司</span>
                      <input
                        className="input input-bordered"
                        onChange={(event) =>
                          onSave({ ...settings, defaultCompany: event.target.value })
                        }
                        value={settings.defaultCompany}
                      />
                    </label>

                    <label className="form-control gap-2">
                      <span className="label-text font-medium">默认部门</span>
                      <input
                        className="input input-bordered"
                        onChange={(event) =>
                          onSave({ ...settings, defaultDepartment: event.target.value })
                        }
                        value={settings.defaultDepartment}
                      />
                    </label>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="form-control gap-2">
                      <span className="label-text font-medium">默认 Shell</span>
                      <select
                        className="select select-bordered"
                        onChange={(event) =>
                          onSave({ ...settings, defaultShell: event.target.value })
                        }
                        value={settings.defaultShell}
                      >
                        <option>PowerShell 7.5</option>
                        <option>pwsh</option>
                        <option>cmd</option>
                      </select>
                    </label>

                    <label className="form-control gap-2">
                      <span className="label-text font-medium">默认权限模式</span>
                      <select
                        className="select select-bordered"
                        onChange={(event) =>
                          onSave({ ...settings, defaultPermission: event.target.value })
                        }
                        value={settings.defaultPermission}
                      >
                        <option>受限模式</option>
                        <option>完全权限</option>
                      </select>
                    </label>

                    <label className="form-control gap-2 md:col-span-2">
                      <span className="label-text font-medium">默认项目命名</span>
                      <select
                        className="select select-bordered"
                        onChange={(event) =>
                          onSave({
                            ...settings,
                            defaultProjectStrategy: event.target.value as AppSettings["defaultProjectStrategy"],
                          })
                        }
                        value={settings.defaultProjectStrategy}
                      >
                        <option value="random32">随机 32 进制</option>
                        <option value="snowflake32">雪花算法 32 进制</option>
                        <option value="datetime32">日期时间 32 进制</option>
                      </select>
                    </label>
                  </div>
                  </div>
                </div>

                <div className="card border border-base-300 bg-base-100 shadow-sm">
                  <div className="card-body gap-4">
                    <h3 className="card-title text-lg">默认行为</h3>

                  <label className="label cursor-pointer justify-between rounded-box border border-base-300 px-4 py-3">
                    <div>
                      <span className="label-text font-medium">启动时自动恢复会话</span>
                      <p className="mt-1 text-xs text-base-content/60">
                        打开客户端后自动检查并恢复员工 CLI。
                      </p>
                    </div>
                    <input
                      checked={settings.autoRestoreSessions}
                      className="toggle toggle-primary"
                      onChange={(event) =>
                        onSave({
                          ...settings,
                          autoRestoreSessions: event.target.checked,
                        })
                      }
                      type="checkbox"
                    />
                  </label>

                  <label className="label cursor-pointer justify-between rounded-box border border-base-300 px-4 py-3">
                    <div>
                      <span className="label-text font-medium">点击卡片直接进入终端</span>
                      <p className="mt-1 text-xs text-base-content/60">
                        关闭时仍保留详情弹窗模式。
                      </p>
                    </div>
                    <input
                      checked={settings.directTerminalOpen}
                      className="toggle toggle-primary"
                      onChange={(event) =>
                        onSave({
                          ...settings,
                          directTerminalOpen: event.target.checked,
                        })
                      }
                      type="checkbox"
                    />
                  </label>

                  <div className="rounded-box border border-base-300 px-4 py-4">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">终端字号</span>
                      <span className="text-sm text-base-content/60">
                        {settings.terminalFontSize}px
                      </span>
                    </div>
                    <input
                      className="range range-primary mt-4"
                      max="18"
                      min="11"
                      onChange={(event) =>
                        onSave({
                          ...settings,
                          terminalFontSize: Number(event.target.value),
                        })
                      }
                      step="1"
                      type="range"
                      value={settings.terminalFontSize}
                    />
                  </div>
                  </div>
                </div>

                <div className="card border border-base-300 bg-base-100 shadow-sm xl:col-span-2">
                  <div className="card-body gap-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="card-title text-lg">API 鉴权</h3>
                        <p className="mt-1 text-sm text-base-content/60">
                          为本地 REST 接口和终端 WebSocket 增加可选的 API Key 保护。
                        </p>
                      </div>
                      <label className="label cursor-pointer gap-3">
                        <span className="label-text font-medium">启用鉴权</span>
                        <input
                          checked={apiSecurityState.enabled}
                          className="toggle toggle-primary"
                          onChange={(event) =>
                            onApiSecurityChange({ enabled: event.target.checked })
                          }
                          type="checkbox"
                        />
                      </label>
                    </div>

                    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto_auto]">
                      <label className="form-control gap-2">
                        <span className="label-text font-medium">API Key</span>
                        <input
                          className="input input-bordered"
                          onChange={(event) =>
                            onApiSecurityChange({ apiKey: event.target.value })
                          }
                          placeholder="留空表示关闭本地接口鉴权"
                          type="password"
                          value={apiSecurityState.apiKey}
                        />
                      </label>

                      <button className="btn btn-outline self-end" onClick={onGenerateApiKey} type="button">
                        生成 Key
                      </button>

                      <button
                        className={`btn btn-primary self-end ${apiSecurityState.saving ? "loading" : ""}`}
                        onClick={onSaveApiSecurity}
                        type="button"
                      >
                        {apiSecurityState.saving ? "保存中" : "保存鉴权"}
                      </button>
                    </div>

                    <div className="text-xs text-base-content/50">
                      配置文件：{apiSecurityState.filePath || "尚未初始化"}
                    </div>

                    {apiSecurityState.error ? (
                      <div className="alert alert-error">
                        <span>{apiSecurityState.error}</span>
                      </div>
                    ) : null}

                    <div className="rounded-box border border-base-300 px-4 py-4 text-sm text-base-content/70">
                      <p>REST 请求头：`X-CClient-Key`</p>
                      <p className="mt-1">终端 WebSocket：`/terminal?...&token=YOUR_KEY`</p>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {activeTab === "theme" ? (
            <div className="card border border-base-300 bg-base-100 shadow-sm">
              <div className="card-body gap-4">
                <div className="flex items-center justify-between">
                  <h3 className="card-title text-lg">主题切换</h3>
                  <span className="badge badge-outline">{settings.theme}</span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {daisyThemeOptions.map((theme) => {
                    const active = settings.theme === theme;

                    return (
                      <button
                        key={theme}
                        className={`card border text-left shadow-none transition ${
                          active
                            ? "border-primary bg-primary/5"
                            : "border-base-300 bg-base-100"
                        }`}
                        data-theme={theme}
                        onClick={() => onSave({ ...settings, theme })}
                        type="button"
                      >
                        <div className="card-body gap-3 p-3">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-semibold capitalize text-base-content">
                              {theme}
                            </span>
                            {active ? <span className="badge badge-primary">当前</span> : null}
                          </div>
                          <div className="flex gap-2">
                            <div className="h-4 flex-1 rounded-btn bg-primary"></div>
                            <div className="h-4 flex-1 rounded-btn bg-secondary"></div>
                            <div className="h-4 flex-1 rounded-btn bg-accent"></div>
                          </div>
                          <div className="h-10 rounded-box border border-base-300 bg-base-100"></div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            ) : null}

            {activeTab === "rules" ? (
            <div className="card border border-base-300 bg-base-100 shadow-sm">
              <div className="card-body gap-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="card-title text-lg">提示白名单</h3>
                    <p className="mt-1 text-sm text-base-content/60">
                      匹配固定提示并回复预设选项，避免逐个进入终端确认。
                    </p>
                  </div>
                  <button className="btn btn-outline btn-sm" onClick={onAddPromptRule} type="button">
                    新增规则
                  </button>
                </div>

                <div className="text-xs text-base-content/50">
                  规则文件：{promptRulesState.filePath || "尚未初始化"}
                </div>

                {promptRulesState.loading ? (
                  <div className="alert alert-info">
                    <span>正在加载提示白名单...</span>
                  </div>
                ) : null}

                {promptRulesState.error ? (
                  <div className="alert alert-error">
                    <span>{promptRulesState.error}</span>
                  </div>
                ) : null}

                <div className="space-y-4">
                  {promptRulesState.rules.length === 0 ? (
                    <div className="rounded-box border border-dashed border-base-300 px-4 py-4 text-sm text-base-content/60">
                      当前没有自定义白名单规则，系统会只使用内置安全规则。
                    </div>
                  ) : (
                    promptRulesState.rules.map((rule) => (
                      <div key={rule.id} className="rounded-box border border-base-300 bg-base-100 p-4">
                        <div className="grid gap-4 xl:grid-cols-[160px_minmax(0,1fr)_200px_auto]">
                          <label className="label cursor-pointer justify-start gap-3 rounded-box border border-base-300 px-4 py-3">
                            <input
                              checked={rule.enabled}
                              className="toggle toggle-primary"
                              onChange={(event) =>
                                onPromptRuleChange(rule.id, { enabled: event.target.checked })
                              }
                              type="checkbox"
                            />
                            <span className="label-text">启用</span>
                          </label>

                          <label className="form-control gap-2">
                            <span className="label-text font-medium">匹配文本</span>
                            <input
                              className="input input-bordered"
                              onChange={(event) =>
                                onPromptRuleChange(rule.id, { pattern: event.target.value })
                              }
                              placeholder="例如：Press enter to continue"
                              value={rule.pattern}
                            />
                          </label>

                          <label className="form-control gap-2">
                            <span className="label-text font-medium">自动动作</span>
                            <select
                              className="select select-bordered"
                              onChange={(event) =>
                                onPromptRuleChange(rule.id, {
                                  action: event.target.value as PromptRule["action"],
                                })
                              }
                              value={rule.action}
                            >
                              {promptRuleActionOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>

                          <button
                            className="btn btn-outline btn-error self-end"
                            onClick={() => onDeletePromptRule(rule.id)}
                            type="button"
                          >
                            删除
                          </button>
                        </div>

                        <label className="form-control mt-4 gap-2">
                          <span className="label-text font-medium">规则名称</span>
                          <input
                            className="input input-bordered"
                            onChange={(event) =>
                              onPromptRuleChange(rule.id, { name: event.target.value })
                            }
                            placeholder="例如：继续执行提示"
                            value={rule.name}
                          />
                        </label>
                      </div>
                    ))
                  )}
                </div>

                <div className="flex items-center justify-between gap-4">
                  <p className="text-xs text-base-content/60">
                    第一版仅支持“文本包含 -&gt; 固定回复”，不支持正则和任意命令。
                  </p>
                  <button
                    className={`btn btn-primary ${promptRulesState.saving ? "loading" : ""}`}
                    disabled={promptRulesState.loading || promptRulesState.saving}
                    onClick={onSavePromptRules}
                    type="button"
                  >
                    {promptRulesState.saving ? "保存中" : "保存白名单"}
                  </button>
                </div>
              </div>
            </div>
            ) : null}
          </div>
        </div>

        <div className="modal-action mt-0 shrink-0 justify-end gap-3 border-t border-base-300 bg-base-100 px-6 py-4">
          <button className="btn btn-outline" onClick={onClose} type="button">
            关闭
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
