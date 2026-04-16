import { useMemo, useState } from "react";
import {
  buildDefaultCodexConfigToml,
  type CodexAuthValues,
  type CodexConfigValues,
  type CodexSettingsState,
} from "../data/codex-config";

type CodexSettingsPanelProps = {
  description?: string;
  onChangeAuth: (patch: Partial<CodexAuthValues>) => void;
  onChangeConfig: (patch: Partial<CodexConfigValues>) => void;
  onChangeConfigToml: (next: string) => void;
  onSave: () => void;
  onTest: () => void;
  saveLabel?: string;
  state: CodexSettingsState;
  title?: string;
};

type CodexPanelTab = "form" | "raw";

export function CodexSettingsPanel({
  description = "配置 Codex 的模型、提供方、API Key 与连通性测试。",
  onChangeAuth,
  onChangeConfig,
  onChangeConfigToml,
  onSave,
  onTest,
  saveLabel = "保存 Codex 配置",
  state,
  title = "Codex 配置",
}: CodexSettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<CodexPanelTab>("form");

  const statusTone = useMemo(() => {
    if (state.testError) {
      return "badge-error";
    }
    if (state.testMessage) {
      return "badge-success";
    }
    if (state.configured) {
      return "badge-info";
    }
    return "badge-outline";
  }, [state.configured, state.testError, state.testMessage]);

  const statusLabel = useMemo(() => {
    if (state.testError) {
      return "测试失败";
    }
    if (state.testMessage) {
      return "已验证";
    }
    if (state.configured) {
      return "已配置";
    }
    return "待配置";
  }, [state.configured, state.testError, state.testMessage]);

  const updateConfig = (patch: Partial<CodexConfigValues>) => {
    const nextConfig = {
      ...state.config,
      ...patch,
    };
    onChangeConfig(patch);
    onChangeConfigToml(buildDefaultCodexConfigToml(nextConfig));
  };

  return (
    <div className="card border border-base-300 bg-base-100 shadow-sm">
      <div className="card-body gap-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h3 className="card-title text-lg">{title}</h3>
            <p className="text-sm text-base-content/60">{description}</p>
          </div>
          <span className={`badge ${statusTone} px-3 py-3`}>{statusLabel}</span>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-box border border-base-300 bg-base-200 px-4 py-3 text-sm">
            <p className="text-xs uppercase tracking-[0.14em] text-base-content/50">
              Codex Home
            </p>
            <p className="mt-2 break-all text-base-content/70">
              {state.codexHome || "尚未解析"}
            </p>
          </div>
          <div className="rounded-box border border-base-300 bg-base-200 px-4 py-3 text-sm">
            <p className="text-xs uppercase tracking-[0.14em] text-base-content/50">
              Codex 命令
            </p>
            <p className="mt-2 text-base-content/70">
              {state.codexCommandAvailable ? "已检测到 codex 命令" : "当前环境未检测到 codex 命令"}
            </p>
          </div>
        </div>

        <div className="tabs tabs-boxed w-fit gap-2 bg-base-200 p-1">
          <button
            className={`tab ${activeTab === "form" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("form")}
            type="button"
          >
            表单配置
          </button>
          <button
            className={`tab ${activeTab === "raw" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("raw")}
            type="button"
          >
            config.toml
          </button>
        </div>

        {activeTab === "form" ? (
          <div className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="form-control gap-2">
                <span className="label-text font-medium">模型提供方</span>
                <input
                  className="input input-bordered"
                  onChange={(event) => updateConfig({ modelProvider: event.target.value })}
                  value={state.config.modelProvider}
                />
              </label>

              <label className="form-control gap-2">
                <span className="label-text font-medium">Provider 名称</span>
                <input
                  className="input input-bordered"
                  onChange={(event) => updateConfig({ providerName: event.target.value })}
                  value={state.config.providerName}
                />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="form-control gap-2">
                <span className="label-text font-medium">主模型</span>
                <input
                  className="input input-bordered"
                  onChange={(event) => updateConfig({ model: event.target.value })}
                  value={state.config.model}
                />
              </label>

              <label className="form-control gap-2">
                <span className="label-text font-medium">评审模型</span>
                <input
                  className="input input-bordered"
                  onChange={(event) => updateConfig({ reviewModel: event.target.value })}
                  value={state.config.reviewModel}
                />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <label className="form-control gap-2">
                <span className="label-text font-medium">推理强度</span>
                <select
                  className="select select-bordered"
                  onChange={(event) =>
                    updateConfig({ modelReasoningEffort: event.target.value })
                  }
                  value={state.config.modelReasoningEffort}
                >
                  <option value="minimal">minimal</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                </select>
              </label>

              <label className="form-control gap-2">
                <span className="label-text font-medium">Wire API</span>
                <select
                  className="select select-bordered"
                  onChange={(event) => updateConfig({ wireApi: event.target.value })}
                  value={state.config.wireApi}
                >
                  <option value="responses">responses</option>
                  <option value="chat_completions">chat_completions</option>
                </select>
              </label>

              <label className="form-control gap-2">
                <span className="label-text font-medium">网络访问</span>
                <select
                  className="select select-bordered"
                  onChange={(event) => updateConfig({ networkAccess: event.target.value })}
                  value={state.config.networkAccess}
                >
                  <option value="enabled">enabled</option>
                  <option value="restricted">restricted</option>
                  <option value="disabled">disabled</option>
                </select>
              </label>
            </div>

            <label className="form-control gap-2">
              <span className="label-text font-medium">Base URL</span>
              <input
                className="input input-bordered"
                onChange={(event) => updateConfig({ baseUrl: event.target.value })}
                placeholder="https://cpa.56781234.xyz/v1"
                value={state.config.baseUrl}
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="form-control gap-2">
                <span className="label-text font-medium">Context Window</span>
                <input
                  className="input input-bordered"
                  min={1}
                  onChange={(event) =>
                    updateConfig({
                      modelContextWindow: Number(event.target.value) || 0,
                    })
                  }
                  type="number"
                  value={state.config.modelContextWindow}
                />
              </label>

              <label className="form-control gap-2">
                <span className="label-text font-medium">Auto Compact Token Limit</span>
                <input
                  className="input input-bordered"
                  min={1}
                  onChange={(event) =>
                    updateConfig({
                      modelAutoCompactTokenLimit: Number(event.target.value) || 0,
                    })
                  }
                  type="number"
                  value={state.config.modelAutoCompactTokenLimit}
                />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="label cursor-pointer justify-between rounded-box border border-base-300 px-4 py-3">
                <div>
                  <span className="label-text font-medium">禁用响应存储</span>
                  <p className="mt-1 text-xs text-base-content/60">
                    对应 `disable_response_storage`
                  </p>
                </div>
                <input
                  checked={state.config.disableResponseStorage}
                  className="toggle toggle-primary"
                  onChange={(event) =>
                    updateConfig({ disableResponseStorage: event.target.checked })
                  }
                  type="checkbox"
                />
              </label>

              <label className="label cursor-pointer justify-between rounded-box border border-base-300 px-4 py-3">
                <div>
                  <span className="label-text font-medium">已确认 WSL 提示</span>
                  <p className="mt-1 text-xs text-base-content/60">
                    对应 `windows_wsl_setup_acknowledged`
                  </p>
                </div>
                <input
                  checked={state.config.windowsWslSetupAcknowledged}
                  className="toggle toggle-primary"
                  onChange={(event) =>
                    updateConfig({
                      windowsWslSetupAcknowledged: event.target.checked,
                    })
                  }
                  type="checkbox"
                />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-[140px_minmax(0,1fr)]">
              <label className="form-control gap-2">
                <span className="label-text font-medium">Auth Mode</span>
                <select
                  className="select select-bordered"
                  onChange={(event) => onChangeAuth({ authMode: event.target.value })}
                  value={state.auth.authMode}
                >
                  <option value="apikey">apikey</option>
                </select>
              </label>

              <label className="form-control gap-2">
                <span className="label-text font-medium">OPENAI_API_KEY</span>
                <input
                  className="input input-bordered"
                  onChange={(event) =>
                    onChangeAuth({ OPENAI_API_KEY: event.target.value })
                  }
                  placeholder="ap-xxxx"
                  type="password"
                  value={state.auth.OPENAI_API_KEY}
                />
              </label>
            </div>
          </div>
        ) : null}

        {activeTab === "raw" ? (
          <div className="space-y-4">
            <div className="alert alert-info">
              <span>
                开发者模式会直接写入 `config.toml`。如果你回到表单模式继续修改，当前模板将按表单值重新生成。
              </span>
            </div>

            <label className="form-control gap-2">
              <span className="label-text font-medium">config.toml 源文件</span>
              <textarea
                className="textarea textarea-bordered min-h-[320px] font-mono text-[13px] leading-6"
                onChange={(event) => onChangeConfigToml(event.target.value)}
                value={state.configToml}
              />
            </label>
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-box border border-base-300 bg-base-200 px-4 py-3 text-sm">
            <p className="text-xs uppercase tracking-[0.14em] text-base-content/50">
              config.toml
            </p>
            <p className="mt-2 break-all text-base-content/70">
              {state.configPath || "尚未初始化"}
            </p>
          </div>
          <div className="rounded-box border border-base-300 bg-base-200 px-4 py-3 text-sm">
            <p className="text-xs uppercase tracking-[0.14em] text-base-content/50">
              auth.json
            </p>
            <p className="mt-2 break-all text-base-content/70">
              {state.authPath || "尚未初始化"}
            </p>
          </div>
        </div>

        {state.testMessage ? (
          <div className="alert alert-success">
            <span>
              {state.testMessage}
              {state.testLatencyMs !== null ? ` · ${state.testLatencyMs}ms` : ""}
              {state.testModels.length > 0 ? ` · ${state.testModels.join(", ")}` : ""}
            </span>
          </div>
        ) : null}

        {state.testError ? (
          <div className="alert alert-error">
            <span>{state.testError}</span>
          </div>
        ) : null}

        {state.error ? (
          <div className="alert alert-error">
            <span>{state.error}</span>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-base-content/60">
            连通性测试会请求 `{state.config.baseUrl.replace(/\/+$/, "") || "base_url"}/models`
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              className={`btn btn-outline ${state.testing ? "loading" : ""}`}
              onClick={onTest}
              type="button"
            >
              {state.testing ? "测试中" : "连通性测试"}
            </button>
            <button
              className={`btn btn-primary ${state.saving ? "loading" : ""}`}
              onClick={onSave}
              type="button"
            >
              {state.saving ? "保存中" : saveLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
