export type CodexConfigValues = {
  approvalPolicy: string;
  baseUrl: string;
  disableResponseStorage: boolean;
  model: string;
  modelAutoCompactTokenLimit: number;
  modelContextWindow: number;
  modelProvider: string;
  modelReasoningEffort: string;
  networkAccess: string;
  providerName: string;
  reviewModel: string;
  sandboxMode: string;
  wireApi: string;
  windowsSandbox: string;
  windowsWslSetupAcknowledged: boolean;
};

export type CodexAuthValues = {
  OPENAI_API_KEY: string;
  authMode: string;
};

export type CodexSettingsState = {
  auth: CodexAuthValues;
  authJson: string;
  authPath: string;
  codexCommandAvailable: boolean;
  codexHome: string;
  configured: boolean;
  config: CodexConfigValues;
  configPath: string;
  configToml: string;
  error: string;
  loading: boolean;
  saving: boolean;
  testError: string;
  testLatencyMs: number | null;
  testMessage: string;
  testModels: string[];
  testing: boolean;
};

export const defaultCodexConfigValues: CodexConfigValues = {
  approvalPolicy: "never",
  baseUrl: "https://cpa.56781234.xyz/v1",
  disableResponseStorage: true,
  model: "gpt-5.4",
  modelAutoCompactTokenLimit: 900000,
  modelContextWindow: 1000000,
  modelProvider: "custom",
  modelReasoningEffort: "xhigh",
  networkAccess: "enabled",
  providerName: "custom",
  reviewModel: "gpt-5.4",
  sandboxMode: "danger-full-access",
  wireApi: "responses",
  windowsSandbox: "unelevated",
  windowsWslSetupAcknowledged: true,
};

export const defaultCodexAuthValues: CodexAuthValues = {
  OPENAI_API_KEY: "",
  authMode: "apikey",
};

export function buildDefaultCodexConfigToml(
  config: CodexConfigValues = defaultCodexConfigValues,
) {
  return [
    `model_provider = "${config.modelProvider}"`,
    `model = "${config.model}"`,
    `review_model = "${config.reviewModel}"`,
    `model_reasoning_effort = "${config.modelReasoningEffort}"`,
    `disable_response_storage = ${config.disableResponseStorage ? "true" : "false"}`,
    `network_access = "${config.networkAccess}"`,
    `approval_policy = "${config.approvalPolicy}"`,
    `sandbox_mode = "${config.sandboxMode}"`,
    `windows_wsl_setup_acknowledged = ${config.windowsWslSetupAcknowledged ? "true" : "false"}`,
    `model_context_window = ${config.modelContextWindow}`,
    `model_auto_compact_token_limit = ${config.modelAutoCompactTokenLimit}`,
    "",
    "[windows]",
    `sandbox = "${config.windowsSandbox}"`,
    "",
    "[model_providers.custom]",
    `name = "${config.providerName}"`,
    `wire_api = "${config.wireApi}"`,
    `base_url = "${config.baseUrl}"`,
    "",
  ].join("\n");
}

export function createDefaultCodexSettingsState(): CodexSettingsState {
  return {
    auth: { ...defaultCodexAuthValues },
    authJson: `${JSON.stringify(
      {
        OPENAI_API_KEY: defaultCodexAuthValues.OPENAI_API_KEY,
        auth_mode: defaultCodexAuthValues.authMode,
      },
      null,
      2,
    )}\n`,
    authPath: "",
    codexCommandAvailable: false,
    codexHome: "",
    configured: false,
    config: { ...defaultCodexConfigValues },
    configPath: "",
    configToml: buildDefaultCodexConfigToml(defaultCodexConfigValues),
    error: "",
    loading: false,
    saving: false,
    testError: "",
    testLatencyMs: null,
    testMessage: "",
    testModels: [],
    testing: false,
  };
}
