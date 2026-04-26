import {
  Suspense,
  lazy,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useNodesState,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AddEmployeeModal } from "./components/add-employee-modal";
import { OnboardingModal } from "./components/onboarding-modal";
import { CompanyFilterDropdown } from "./components/company-filter-dropdown";
import { PendingPromptsModal } from "./components/pending-prompts-modal";
import {
  PublishTaskModal,
  type TaskReferenceAttachmentInput,
} from "./components/publish-task-modal";
import { RuntimeDetailModal } from "./components/runtime-detail-modal";
import { RuntimeNode } from "./components/runtime-node";
import { StatusGuideModal } from "./components/status-guide-modal";
import { SettingsModal, type AppSettings } from "./components/settings-modal";
import {
  createEmptyPromptRule,
  type PromptRule,
} from "./data/prompt-rules";
import {
  createDefaultInspectorSettings,
  type InspectorSettings,
} from "./data/inspector-config";
import { daisyThemeOptions, type DaisyThemeName } from "./data/theme-options";
import {
  createDefaultCodexSettingsState,
  type CodexAuthValues,
  type CodexConfigValues,
  type CodexSettingsState,
} from "./data/codex-config";
import { runtimePublicConfig } from "./data/runtime-config";
import {
  type AgentDefinition,
  createRuntimeMember,
  createRuntimeNode,
  type ElevationMode,
  type PromptAutomationMode,
  type RuntimeFlowNode,
  type RuntimeMember,
  type RuntimeStatus,
  type TaskIntakeStatus,
  type WorkStatus,
  type NewEmployeeForm,
} from "./data/mock-runtime";

const TerminalWindow = lazy(async () => {
  const module = await import("./components/terminal-window");
  return { default: module.TerminalWindow };
});

const nodeTypes: NodeTypes = {
  runtimeNode: RuntimeNode,
};

const BRIDGE_HTTP_ORIGIN = runtimePublicConfig.bridgeHttpOrigin;
const BRIDGE_WS_ORIGIN = runtimePublicConfig.bridgeWsOrigin;

const SETTINGS_STORAGE_KEY = "cclient.settings.v1";
const API_SECURITY_STORAGE_KEY = "cclient.api-security.v1";
const ONBOARDING_DISMISSED_STORAGE_KEY = "cclient.onboarding.dismissed.v1";
const ONBOARDING_TASK_PUBLISHED_STORAGE_KEY = "cclient.onboarding.task-published.v1";
const TOAST_AUTO_CLOSE_MS = 3200;
const RUNTIME_AUTO_REFRESH_MS = 4000;
const CANVAS_LAYOUT_STORAGE_PREFIX = "cclient.canvas-layout.v1";

type RuntimeFilter = "all" | RuntimeStatus | WorkStatus | "recoveryPending";
type CanvasLayoutMap = Record<string, { x: number; y: number }>;

const defaultSettings: AppSettings = {
  agentRepoUrl: "https://github.com/jnMetaCode/agency-agents-zh",
  autoRestoreSessions: true,
  defaultCompany: "未来智造科技",
  defaultDepartment: "产品设计部",
  defaultPermission: "受限模式",
  defaultProjectStrategy: "snowflake32",
  defaultShell: "PowerShell 7.5",
  directTerminalOpen: false,
  projectPath: runtimePublicConfig.defaultProjectPath,
  terminalFontSize: 13,
  theme: "lemonade",
};

export type AgentRepoState = {
  agents: AgentDefinition[];
  cacheRoot: string;
  commit: string;
  error: string;
  lastSyncedAt: string;
  loading: boolean;
  repoUrl: string;
  warning: string;
};

type ApiSecurityState = {
  apiKey: string;
  enabled: boolean;
  error: string;
  filePath: string;
  saving: boolean;
};

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

type PendingPrompt = {
  createdAt: string;
  id: string;
  memberId: string;
  responseMode: "approve_reject" | "continue_only" | "notify_only";
  summary: string;
  title: string;
  type: string;
  workspacePath: string;
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

type PromptHandlingLog = {
  action: string;
  createdAt: string;
  memberId: string;
  mode: string;
  summary: string;
  title: string;
  workspacePath: string;
};

type PromptRulesState = {
  error: string;
  filePath: string;
  loading: boolean;
  rules: PromptRule[];
  saving: boolean;
};

type InspectorSettingsState = {
  error: string;
  filePath: string;
  loading: boolean;
  saving: boolean;
  settings: InspectorSettings;
  testError: string;
  testLatencyMs: number | null;
  testMessage: string;
  testModels: string[];
  testing: boolean;
};

function loadSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return defaultSettings;
    }
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const theme = daisyThemeOptions.includes(parsed.theme as DaisyThemeName)
      ? (parsed.theme as DaisyThemeName)
      : defaultSettings.theme;
    const migratedProjectPath =
      parsed.projectPath === "D:/PROJECT/COMPANY/未来智造科技"
        ? "D:/PROJECT/COMPANY"
        : parsed.projectPath;

    return {
      ...defaultSettings,
      ...parsed,
      projectPath: migratedProjectPath ?? defaultSettings.projectPath,
      theme,
    };
  } catch {
    return defaultSettings;
  }
}

function loadApiSecurityState(): ApiSecurityState {
  try {
    const raw = window.localStorage.getItem(API_SECURITY_STORAGE_KEY);
    if (!raw) {
      return {
        apiKey: "",
        enabled: false,
        error: "",
        filePath: "",
        saving: false,
      };
    }

    const parsed = JSON.parse(raw) as Partial<ApiSecurityState>;
    return {
      apiKey: parsed.apiKey ?? "",
      enabled: Boolean(parsed.enabled),
      error: "",
      filePath: parsed.filePath ?? "",
      saving: false,
    };
  } catch {
    return {
      apiKey: "",
      enabled: false,
      error: "",
      filePath: "",
      saving: false,
    };
  }
}

type DiscoveredRuntime = {
  company?: string;
  currentTask: string;
  department?: string;
  employeeCode: string;
  employeeName: string;
  inspector?: RuntimeMember["inspector"];
  nextAction?: string;
  memberId?: string;
  permission: string;
  pid?: number;
  projectName: string;
  recoveryPending?: boolean;
  recentArtifact?: string | null;
  recentCompleted?: string | null;
  repoSource: string;
  resolvedShell: string;
  role: string;
  runtimeStatus: RuntimeMember["runtimeStatus"];
  sessionId: string;
  shell: string;
  startedAt: string;
  taskDeadline?: string | null;
  taskIntakeStatus?: TaskIntakeStatus;
  taskPriority?: string | null;
  taskQueue?: string[];
  autoTrustWorkspace?: boolean;
  elevationMode?: ElevationMode;
  promptAutomation?: PromptAutomationMode;
  taskSource?: string | null;
  taskTimeWindow?: string | null;
  lastAction?: string;
  status: string;
  stoppedAt: string | null;
  workStatus?: RuntimeMember["workStatus"];
  workspacePath: string;
};

function normalizePathKey(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function extractProjectNameFromWorkspace(workspacePath: string) {
  return workspacePath.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || "未命名项目";
}

function buildBridgeHeaders(
  apiSecurity: Pick<ApiSecurityState, "apiKey" | "enabled">,
  includeJson = true,
) {
  return {
    ...(includeJson ? { "Content-Type": "application/json" } : {}),
    ...(apiSecurity.enabled && apiSecurity.apiKey.trim()
      ? { "X-CClient-Key": apiSecurity.apiKey.trim() }
      : {}),
  };
}

function buildBridgeUrl(path: string) {
  return `${BRIDGE_HTTP_ORIGIN}${path}`;
}

function buildBridgeDownloadUrl(
  endpointPath: string,
  params: Record<string, string | null | undefined>,
  apiSecurity: Pick<ApiSecurityState, "apiKey" | "enabled">,
) {
  const url = new URL(`${BRIDGE_HTTP_ORIGIN}${endpointPath}`);

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.trim()) {
      url.searchParams.set(key, value);
    }
  }

  if (apiSecurity.enabled && apiSecurity.apiKey.trim()) {
    url.searchParams.set("token", apiSecurity.apiKey.trim());
  }

  return url.toString();
}

function loadStoredBoolean(key: string) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function normalizeCodexSettingsPayload(
  payload: Partial<CodexSettingsState> & {
    auth?: Partial<CodexAuthValues>;
    config?: Partial<CodexConfigValues>;
  },
) {
  const defaults = createDefaultCodexSettingsState();
  return {
    ...defaults,
    ...payload,
    auth: {
      ...defaults.auth,
      ...(payload.auth ?? {}),
    },
    config: {
      ...defaults.config,
      ...(payload.config ?? {}),
    },
    loading: false,
    saving: false,
    testing: false,
  } satisfies CodexSettingsState;
}

function generateApiKeyValue() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const values = crypto.getRandomValues(new Uint8Array(40));
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

function hashString(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}

function buildRecoveredMemberId(runtime: DiscoveredRuntime) {
  if (runtime.memberId?.trim()) {
    return runtime.memberId.trim();
  }

  const seed = [
    runtime.employeeCode,
    runtime.employeeName,
    runtime.projectName,
    runtime.workspacePath,
  ]
    .filter(Boolean)
    .join("|");

  const label = (runtime.employeeCode || runtime.employeeName || "member")
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return `emp-${label || "member"}-${hashString(seed || runtime.workspacePath)}`;
}

function buildMemberLookupKeys(input: {
  employeeCode?: string;
  memberId?: string;
  name?: string;
  workspace?: string;
}) {
  const keys: string[] = [];

  if (input.memberId?.trim()) {
    keys.push(`member:${input.memberId.trim().toLowerCase()}`);
  }
  if (input.workspace?.trim()) {
    keys.push(`workspace:${normalizePathKey(input.workspace)}`);
  }
  if (input.employeeCode?.trim()) {
    keys.push(`employee:${input.employeeCode.trim().toLowerCase()}`);
  }
  if (input.name?.trim()) {
    keys.push(`name:${input.name.trim().toLowerCase()}`);
  }

  return keys;
}

function buildCanvasLayoutStorageKey(projectPath: string) {
  return `${CANVAS_LAYOUT_STORAGE_PREFIX}:${normalizePathKey(projectPath || "default")}`;
}

function loadCanvasLayout(projectPath: string): CanvasLayoutMap {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(buildCanvasLayoutStorageKey(projectPath));
    return raw ? (JSON.parse(raw) as CanvasLayoutMap) : {};
  } catch {
    return {};
  }
}

function saveCanvasLayout(projectPath: string, layout: CanvasLayoutMap) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    buildCanvasLayoutStorageKey(projectPath),
    JSON.stringify(layout),
  );
}

function buildNodesFromDiscoveredRuntimes(
  runtimes: DiscoveredRuntime[],
  currentNodes: RuntimeFlowNode[],
  projectPath: string,
) {
  const savedLayout = loadCanvasLayout(projectPath);
  const nodeLookup = new Map<string, RuntimeFlowNode>();

  for (const node of currentNodes) {
    for (const key of buildMemberLookupKeys({
      employeeCode: node.data.employeeCode,
      memberId: node.id,
      name: node.data.name,
      workspace: node.data.workspace,
    })) {
      if (!nodeLookup.has(key)) {
        nodeLookup.set(key, node);
      }
    }
  }

  return runtimes.map((runtime, index) => {
    const recovered = memberFromDiscoveredRuntime(runtime);
    const existingNode = buildMemberLookupKeys({
      employeeCode: recovered.employeeCode,
      memberId: recovered.id,
      name: recovered.name,
      workspace: recovered.workspace,
    })
      .map((key) => nodeLookup.get(key))
      .find(Boolean);

    const nextNode = existingNode
      ? {
          ...existingNode,
          id: recovered.id,
          data: {
            ...existingNode.data,
            ...recovered,
          },
        }
      : createRuntimeNode(recovered, index);

    const savedPosition = savedLayout[`workspace:${normalizePathKey(recovered.workspace)}`];

    if (savedPosition) {
      nextNode.position = savedPosition;
    }

    return nextNode;
  });
}

function heartbeatLabelFromRuntime(runtime: DiscoveredRuntime) {
  if (runtime.runtimeStatus === "error") {
    return "异常待处理";
  }
  if (runtime.runtimeStatus === "stopped") {
    if (runtime.recoveryPending) {
      return "待恢复";
    }
    return "已停止";
  }
  if (!runtime.startedAt) {
    return "刚刚启动";
  }
  const started = new Date(runtime.startedAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `启动于 ${started}`;
}

function memberFromDiscoveredRuntime(runtime: DiscoveredRuntime): RuntimeMember {
  const workStatus = runtime.workStatus ?? "idle";
  const recoveryPending = Boolean(runtime.recoveryPending);

  return {
    blockedTasks: [],
    automationSettings: {
      autoTrustWorkspace: runtime.autoTrustWorkspace ?? true,
      elevationMode: runtime.elevationMode ?? "manual",
      promptAutomation: runtime.promptAutomation ?? "safe_auto",
    },
    company: runtime.company || "未分配公司",
    currentTask: runtime.currentTask,
    department: runtime.department || "未分配部门",
    diagnostics: [
      runtime.sessionId ? `session ${runtime.sessionId}` : "session -",
      typeof runtime.pid === "number" ? `pid ${runtime.pid}` : "pid -",
      runtime.resolvedShell ? `shell ${runtime.resolvedShell}` : "shell -",
      recoveryPending ? "待恢复：可通过重启 CLI 恢复上下文" : "恢复状态正常",
    ],
    employeeCode: runtime.employeeCode || "UNKNOWN",
    heartbeatLabel: heartbeatLabelFromRuntime(runtime),
    id: buildRecoveredMemberId(runtime),
    inspector: runtime.inspector ?? null,
    name: runtime.employeeName,
    nextAction: runtime.nextAction ?? "暂无",
    permission: runtime.permission,
    projectName: runtime.projectName || runtime.workspacePath.split(/[\\/]/).filter(Boolean).pop() || "未命名项目",
    progress:
      runtime.runtimeStatus === "error"
        ? 0.08
        : runtime.runtimeStatus === "running"
          ? workStatus === "busy"
            ? 0.58
            : workStatus === "blocked"
              ? 0.3
              : 0.42
          : 0.12,
    recentArtifact: runtime.recentArtifact ?? null,
    recentCompleted: runtime.recentCompleted ?? null,
    repoSource: runtime.repoSource,
    role: runtime.role,
    recoveryPending,
    taskDeadline: runtime.taskDeadline ?? null,
    taskIntakeStatus: runtime.taskIntakeStatus ?? "none",
    taskPriority: runtime.taskPriority ?? null,
    taskSource: runtime.taskSource ?? null,
    taskTimeWindow: runtime.taskTimeWindow ?? null,
    runtimeInfo: {
      lastAction: runtime.lastAction ?? runtime.status,
      pid: runtime.pid,
      resolvedShell: runtime.resolvedShell,
      sessionId: runtime.sessionId,
      startedAt: runtime.startedAt,
      status: runtime.status,
      stoppedAt: runtime.stoppedAt,
    },
    runtimeStatus: runtime.runtimeStatus,
    shell: runtime.shell,
    taskQueue: Array.isArray(runtime.taskQueue) ? runtime.taskQueue : [],
    workStatus,
    workspace: runtime.workspacePath,
    agentStatus: "unverified",
  };
}

function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<RuntimeFlowNode>([]);
  const [detailMemberId, setDetailMemberId] = useState<string | null>(null);
  const [terminalMemberId, setTerminalMemberId] = useState<string | null>(null);
  const [addEmployeeOpen, setAddEmployeeOpen] = useState(false);
  const [publishTaskOpen, setPublishTaskOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingChildFlow, setOnboardingChildFlow] = useState<null | "employee" | "task">(null);
  const [pendingPromptsOpen, setPendingPromptsOpen] = useState(false);
  const [statusGuideOpen, setStatusGuideOpen] = useState(false);
  const [hasWorkspaceScanCompleted, setHasWorkspaceScanCompleted] = useState(false);
  const [detailHistoryRefreshToken, setDetailHistoryRefreshToken] = useState(0);
  const [restartingMemberIds, setRestartingMemberIds] = useState<string[]>([]);
  const [companyDropdownOpen, setCompanyDropdownOpen] = useState(false);
  const [availableCompanies, setAvailableCompanies] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string>("all");
  const [runtimeFilter, setRuntimeFilter] = useState<RuntimeFilter>("all");
  const [workspaceMessage, setWorkspaceMessage] = useState<string>("");
  const [workspaceError, setWorkspaceError] = useState<string>("");
  const [detailHistory, setDetailHistory] = useState<{
    artifacts: DeliveryHistoryEntry[];
    finished: DeliveryHistoryEntry[];
    loading: boolean;
  }>({
    artifacts: [],
    finished: [],
    loading: false,
  });
  const [detailProjects, setDetailProjects] = useState<{
    items: ProjectSpaceEntry[];
    loading: boolean;
  }>({
    items: [],
    loading: false,
  });
  const [detailInspector, setDetailInspector] = useState<{
    loading: boolean;
    result: RuntimeMember["inspector"];
  }>({
    loading: false,
    result: null,
  });
  const [settings, setSettings] = useState<AppSettings>(() =>
    typeof window === "undefined" ? defaultSettings : loadSettings(),
  );
  const [apiSecurity, setApiSecurity] = useState<ApiSecurityState>(() =>
    typeof window === "undefined"
      ? {
          apiKey: "",
          enabled: false,
          error: "",
          filePath: "",
          saving: false,
        }
      : loadApiSecurityState(),
  );
  const [codexSettingsState, setCodexSettingsState] = useState<CodexSettingsState>(() => ({
    ...createDefaultCodexSettingsState(),
    loading: true,
  }));
  const [agentRepoState, setAgentRepoState] = useState<AgentRepoState>({
    agents: [],
    cacheRoot: "",
    commit: "",
    error: "",
    lastSyncedAt: "",
    loading: false,
    repoUrl: "",
    warning: "",
  });
  const [promptRulesState, setPromptRulesState] = useState<PromptRulesState>({
    error: "",
    filePath: "",
    loading: false,
    rules: [],
    saving: false,
  });
  const [inspectorSettingsState, setInspectorSettingsState] = useState<InspectorSettingsState>({
    error: "",
    filePath: "",
    loading: false,
    saving: false,
    settings: createDefaultInspectorSettings(),
    testError: "",
    testLatencyMs: null,
    testMessage: "",
    testModels: [],
    testing: false,
  });
  const [pendingPrompts, setPendingPrompts] = useState<PendingPrompt[]>([]);
  const [promptHandlingLogs, setPromptHandlingLogs] = useState<PromptHandlingLog[]>([]);
  const [hasDismissedOnboarding, setHasDismissedOnboarding] = useState<boolean>(() =>
    typeof window === "undefined" ? false : loadStoredBoolean(ONBOARDING_DISMISSED_STORAGE_KEY),
  );
  const [hasPublishedOnboardingTask, setHasPublishedOnboardingTask] = useState<boolean>(() =>
    typeof window === "undefined"
      ? false
      : loadStoredBoolean(ONBOARDING_TASK_PUBLISHED_STORAGE_KEY),
  );
  const apiSecurityRef = useRef(apiSecurity);

  useEffect(() => {
    apiSecurityRef.current = apiSecurity;
  }, [apiSecurity]);

  const getBridgeHeaders = useCallback(
    (includeJson = true) => buildBridgeHeaders(apiSecurityRef.current, includeJson),
    [],
  );

  const triggerBrowserDownload = useCallback((downloadUrl: string) => {
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", settings.theme);
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    window.localStorage.setItem(
      API_SECURITY_STORAGE_KEY,
      JSON.stringify({
        apiKey: apiSecurity.apiKey,
        enabled: apiSecurity.enabled,
        filePath: apiSecurity.filePath,
      }),
    );
  }, [apiSecurity.apiKey, apiSecurity.enabled, apiSecurity.filePath]);

  useEffect(() => {
    window.localStorage.setItem(
      ONBOARDING_DISMISSED_STORAGE_KEY,
      hasDismissedOnboarding ? "1" : "0",
    );
  }, [hasDismissedOnboarding]);

  useEffect(() => {
    window.localStorage.setItem(
      ONBOARDING_TASK_PUBLISHED_STORAGE_KEY,
      hasPublishedOnboardingTask ? "1" : "0",
    );
  }, [hasPublishedOnboardingTask]);

  useEffect(() => {
    if (!hasWorkspaceScanCompleted) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      const layout = nodes.reduce<CanvasLayoutMap>((result, node) => {
        if (node.data.workspace) {
          result[`workspace:${normalizePathKey(node.data.workspace)}`] = node.position;
        }
        return result;
      }, {});

      saveCanvasLayout(settings.projectPath, layout);
    }, 180);

    return () => {
      window.clearTimeout(timer);
    };
  }, [hasWorkspaceScanCompleted, nodes, settings.projectPath]);

  useEffect(() => {
    if (!workspaceMessage) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setWorkspaceMessage("");
    }, TOAST_AUTO_CLOSE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [workspaceMessage]);

  useEffect(() => {
    if (!workspaceError) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setWorkspaceError("");
    }, TOAST_AUTO_CLOSE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [workspaceError]);

  const refreshWorkspaceNodes = useCallback(
    async ({ silent = false } = {}) => {
      try {
        const response = await fetch(buildBridgeUrl("/api/workspace/discover"), {
          method: "POST",
          headers: getBridgeHeaders(),
          body: JSON.stringify({
            projectRoot: settings.projectPath,
          }),
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "工作空间扫描失败");
        }

        startTransition(() => {
          setNodes((current) =>
            buildNodesFromDiscoveredRuntimes(
              payload.runtimes as DiscoveredRuntime[],
              current,
              settings.projectPath,
            ),
          );
        });
        setAvailableCompanies(Array.isArray(payload.companies) ? payload.companies : []);

        if (!silent) {
          const count = Array.isArray(payload.runtimes) ? payload.runtimes.length : 0;
          setWorkspaceMessage(
            count > 0
              ? `已恢复 ${count} 个员工工作空间`
              : "当前项目路径下未发现员工工作空间",
          );
        }
      } catch (error) {
        setAvailableCompanies([]);
        if (!silent) {
          setWorkspaceError(
            error instanceof Error ? error.message : "工作空间扫描失败",
          );
        }
      } finally {
        setHasWorkspaceScanCompleted(true);
      }
    },
    [setNodes, settings.projectPath],
  );

  useEffect(() => {
    void refreshWorkspaceNodes({ silent: true });
  }, [refreshWorkspaceNodes]);

  const hasRunningNodes = useMemo(
    () => nodes.some((node) => node.data.runtimeStatus === "running"),
    [nodes],
  );

  useEffect(() => {
    if (!hasRunningNodes) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") {
        return;
      }
      void refreshWorkspaceNodes({ silent: true });
    }, RUNTIME_AUTO_REFRESH_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [hasRunningNodes, refreshWorkspaceNodes]);

  const loadPromptRules = useCallback(async () => {
    setPromptRulesState((current) => ({
      ...current,
      error: "",
      loading: true,
    }));

    try {
      const response = await fetch(buildBridgeUrl("/api/settings/prompt-rules/load"), {
        method: "POST",
        headers: getBridgeHeaders(),
        body: JSON.stringify({
          projectRoot: settings.projectPath,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "提示白名单加载失败");
      }

      setPromptRulesState({
        error: "",
        filePath: payload.filePath ?? "",
        loading: false,
        rules: Array.isArray(payload.rules) ? payload.rules : [],
        saving: false,
      });
    } catch (error) {
      setPromptRulesState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "提示白名单加载失败",
        loading: false,
      }));
    }
  }, [settings.projectPath]);

  const loadInspectorSettings = useCallback(async () => {
    setInspectorSettingsState((current) => ({
      ...current,
      error: "",
      loading: true,
    }));

    try {
      const response = await fetch(buildBridgeUrl("/api/settings/inspector/load"), {
        method: "POST",
        headers: getBridgeHeaders(),
        body: JSON.stringify({
          projectRoot: settings.projectPath,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "观察者配置加载失败");
      }

      setInspectorSettingsState({
        error: "",
        filePath: payload.filePath ?? "",
        loading: false,
        saving: false,
        settings: payload.settings ?? createDefaultInspectorSettings(),
        testError: "",
        testLatencyMs: null,
        testMessage: "",
        testModels: [],
        testing: false,
      });
    } catch (error) {
      setInspectorSettingsState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "观察者配置加载失败",
        loading: false,
      }));
    }
  }, [getBridgeHeaders, settings.projectPath]);

  const loadApiSecurity = useCallback(async () => {
    try {
      const response = await fetch(buildBridgeUrl("/api/settings/security/load"), {
        method: "POST",
        headers: getBridgeHeaders(),
        body: JSON.stringify({
          projectRoot: settings.projectPath,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "API 鉴权配置加载失败");
      }

      setApiSecurity((current) => ({
        ...current,
        enabled: Boolean(payload.enabled),
        error: "",
        filePath: payload.filePath ?? "",
        saving: false,
      }));
    } catch (error) {
      setApiSecurity((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "API 鉴权配置加载失败",
        saving: false,
      }));
    }
  }, [getBridgeHeaders, settings.projectPath]);

  const loadCodexSettings = useCallback(async () => {
    setCodexSettingsState((current) => ({
      ...current,
      error: "",
      loading: true,
    }));

    try {
      const response = await fetch(buildBridgeUrl("/api/settings/codex/load"), {
        method: "POST",
        headers: getBridgeHeaders(),
        body: JSON.stringify({}),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Codex 配置加载失败");
      }

      setCodexSettingsState((current) =>
        normalizeCodexSettingsPayload({
          ...current,
          ...payload,
          error: "",
          testError: "",
          testLatencyMs: null,
          testMessage: "",
          testModels: [],
        }),
      );
    } catch (error) {
      setCodexSettingsState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Codex 配置加载失败",
        loading: false,
      }));
    }
  }, [getBridgeHeaders]);

  useEffect(() => {
    void loadCodexSettings();
  }, [loadCodexSettings]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    void loadInspectorSettings();
    void loadPromptRules();
    void loadApiSecurity();
    void loadCodexSettings();
  }, [loadApiSecurity, loadCodexSettings, loadInspectorSettings, loadPromptRules, settingsOpen]);

  useEffect(() => {
    if (!onboardingOpen) {
      return;
    }

    void loadCodexSettings();
  }, [loadCodexSettings, onboardingOpen]);

  const refreshPendingPrompts = useCallback(async () => {
    try {
      const response = await fetch(buildBridgeUrl("/api/runtime/prompts"), {
        headers: getBridgeHeaders(false),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "审核消息加载失败");
      }

      setPendingPrompts(Array.isArray(payload.prompts) ? payload.prompts : []);
      setPromptHandlingLogs(Array.isArray(payload.logs) ? payload.logs : []);
    } catch {
      setPendingPrompts([]);
      setPromptHandlingLogs([]);
    }
  }, []);

  useEffect(() => {
    void refreshPendingPrompts();
  }, [refreshPendingPrompts]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") {
        return;
      }
      void refreshPendingPrompts();
    }, RUNTIME_AUTO_REFRESH_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [refreshPendingPrompts]);

  const hasEmployees = nodes.length > 0;
  const hasPublishedTask = useMemo(
    () =>
      hasPublishedOnboardingTask ||
      nodes.some((node) => {
        const currentTask = node.data.currentTask?.trim() ?? "";
        return (
          node.data.taskIntakeStatus !== "none" ||
          Boolean(node.data.recentCompleted) ||
          Boolean(node.data.recentArtifact) ||
          (Boolean(currentTask) &&
            currentTask !== "等待任务分配" &&
            currentTask !== "当前暂无任务" &&
            currentTask !== "暂无")
        );
      }),
    [hasPublishedOnboardingTask, nodes],
  );
  const needsOnboarding = useMemo(
    () => !codexSettingsState.configured || !hasEmployees || !hasPublishedTask,
    [codexSettingsState.configured, hasEmployees, hasPublishedTask],
  );

  useEffect(() => {
    if (
      hasDismissedOnboarding ||
      codexSettingsState.loading ||
      onboardingChildFlow ||
      addEmployeeOpen ||
      publishTaskOpen
    ) {
      return;
    }

    if (needsOnboarding) {
      setOnboardingOpen(true);
    }
  }, [
    addEmployeeOpen,
    codexSettingsState.loading,
    hasDismissedOnboarding,
    needsOnboarding,
    onboardingChildFlow,
    publishTaskOpen,
  ]);

  useEffect(() => {
    if (!onboardingChildFlow) {
      return;
    }

    if (addEmployeeOpen || publishTaskOpen) {
      return;
    }

    if (!hasDismissedOnboarding && !codexSettingsState.loading && needsOnboarding) {
      setOnboardingOpen(true);
    }

    setOnboardingChildFlow(null);
  }, [
    addEmployeeOpen,
    codexSettingsState.loading,
    hasDismissedOnboarding,
    needsOnboarding,
    onboardingChildFlow,
    publishTaskOpen,
  ]);

  const agentRepoCacheRoot = useMemo(() => {
    const normalized = settings.projectPath.replace(/[\\/]+$/, "");
    return `${normalized}/setting/agent-repo`;
  }, [settings.projectPath]);

  const syncAgentRepo = useCallback(
    async (refresh = false) => {
      if (!settings.agentRepoUrl.trim()) {
        setAgentRepoState((current) => ({
          ...current,
          error: "请先填写 Agent 仓库地址",
          loading: false,
        }));
        return;
      }

      if (
        !refresh &&
        agentRepoState.repoUrl === settings.agentRepoUrl &&
        agentRepoState.cacheRoot === agentRepoCacheRoot &&
        agentRepoState.agents.length > 0
      ) {
        return;
      }

      setAgentRepoState((current) => ({
        ...current,
        error: "",
        loading: true,
        cacheRoot: agentRepoCacheRoot,
        repoUrl: settings.agentRepoUrl,
        warning: "",
      }));

      try {
        const response = await fetch(buildBridgeUrl("/api/agent-repo/list"), {
          method: "POST",
          headers: getBridgeHeaders(),
          body: JSON.stringify({
            cacheRoot: agentRepoCacheRoot,
            refresh,
            repoUrl: settings.agentRepoUrl,
          }),
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "仓库同步失败");
        }

        setAgentRepoState({
          agents: payload.agents ?? [],
          cacheRoot: agentRepoCacheRoot,
          commit: payload.commit ?? "",
          error: "",
          lastSyncedAt: new Date().toLocaleString("zh-CN"),
          loading: false,
          repoUrl: settings.agentRepoUrl,
          warning: payload.warning ?? "",
        });
      } catch (error) {
        setAgentRepoState((current) => ({
          ...current,
          cacheRoot: agentRepoCacheRoot,
          error: error instanceof Error ? error.message : "仓库同步失败",
          loading: false,
          repoUrl: settings.agentRepoUrl,
        }));
      }
    },
    [
      agentRepoCacheRoot,
      agentRepoState.agents.length,
      agentRepoState.cacheRoot,
      agentRepoState.repoUrl,
      settings.agentRepoUrl,
    ],
  );

  const handleCodexConfigChange = useCallback((patch: Partial<CodexConfigValues>) => {
    setCodexSettingsState((current) => ({
      ...current,
      config: {
        ...current.config,
        ...patch,
      },
      configured: false,
      error: "",
      testError: "",
      testLatencyMs: null,
      testMessage: "",
      testModels: [],
    }));
  }, []);

  const handleCodexAuthChange = useCallback((patch: Partial<CodexAuthValues>) => {
    setCodexSettingsState((current) => ({
      ...current,
      auth: {
        ...current.auth,
        ...patch,
      },
      configured: false,
      error: "",
      testError: "",
      testLatencyMs: null,
      testMessage: "",
      testModels: [],
    }));
  }, []);

  const handleCodexConfigTomlChange = useCallback((next: string) => {
    setCodexSettingsState((current) => ({
      ...current,
      configToml: next,
      configured: false,
      error: "",
      testError: "",
      testLatencyMs: null,
      testMessage: "",
      testModels: [],
    }));
  }, []);

  const handleSaveCodexSettings = useCallback(async () => {
    setCodexSettingsState((current) => ({
      ...current,
      error: "",
      saving: true,
    }));

    try {
      const response = await fetch(buildBridgeUrl("/api/settings/codex/save"), {
        method: "POST",
        headers: getBridgeHeaders(),
        body: JSON.stringify({
          auth: codexSettingsState.auth,
          config: codexSettingsState.config,
          configToml: codexSettingsState.configToml,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Codex 配置保存失败");
      }

      setCodexSettingsState(
        normalizeCodexSettingsPayload({
          ...payload,
          error: "",
          testError: "",
          testLatencyMs: null,
          testMessage: "",
          testModels: [],
        }),
      );
      setWorkspaceMessage("Codex 配置已保存");
    } catch (error) {
      setCodexSettingsState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Codex 配置保存失败",
        saving: false,
      }));
      setWorkspaceError(error instanceof Error ? error.message : "Codex 配置保存失败");
    }
  }, [codexSettingsState.auth, codexSettingsState.config, codexSettingsState.configToml, getBridgeHeaders]);

  const handleTestCodexSettings = useCallback(async () => {
    setCodexSettingsState((current) => ({
      ...current,
      testError: "",
      testLatencyMs: null,
      testMessage: "",
      testModels: [],
      testing: true,
    }));

    try {
      const response = await fetch(buildBridgeUrl("/api/settings/codex/test"), {
        method: "POST",
        headers: getBridgeHeaders(),
        body: JSON.stringify({
          auth: codexSettingsState.auth,
          config: codexSettingsState.config,
          configToml: codexSettingsState.configToml,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Codex 连通性测试失败");
      }

      setCodexSettingsState((current) => ({
        ...current,
        testError: "",
        testLatencyMs: typeof payload.latencyMs === "number" ? payload.latencyMs : null,
        testMessage: payload.message ?? "连接成功",
        testModels: Array.isArray(payload.models) ? payload.models : [],
        testing: false,
      }));
      setWorkspaceMessage("Codex 连通性测试成功");
    } catch (error) {
      setCodexSettingsState((current) => ({
        ...current,
        testError: error instanceof Error ? error.message : "Codex 连通性测试失败",
        testing: false,
      }));
      setWorkspaceError(error instanceof Error ? error.message : "Codex 连通性测试失败");
    }
  }, [codexSettingsState.auth, codexSettingsState.config, codexSettingsState.configToml, getBridgeHeaders]);

  const findMemberById = useCallback(
    (memberId: string | null) =>
      memberId ? (nodes.find((node) => node.id === memberId)?.data ?? null) : null,
    [nodes],
  );

  const detailMember = useMemo(
    () => findMemberById(detailMemberId),
    [detailMemberId, findMemberById],
  );

  useEffect(() => {
    if (!detailMember?.workspace) {
      setDetailHistory({
        artifacts: [],
        finished: [],
        loading: false,
      });
      setDetailProjects({
        items: [],
        loading: false,
      });
      setDetailInspector({
        loading: false,
        result: null,
      });
      return;
    }

    let cancelled = false;
    setDetailHistory((current) => ({
      ...current,
      loading: true,
    }));

    fetch(buildBridgeUrl("/api/workspace/history"), {
      method: "POST",
      headers: getBridgeHeaders(),
      body: JSON.stringify({
        workspacePath: detailMember.workspace,
      }),
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "历史交付加载失败");
        }
        return payload;
      })
      .then((payload) => {
        if (cancelled) {
          return;
        }

        setDetailHistory({
          artifacts: Array.isArray(payload.artifacts) ? payload.artifacts : [],
          finished: Array.isArray(payload.finished) ? payload.finished : [],
          loading: false,
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setDetailHistory({
          artifacts: [],
          finished: [],
          loading: false,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [detailHistoryRefreshToken, detailMember?.workspace]);

  useEffect(() => {
    if (!detailMember?.workspace) {
      return;
    }

    let cancelled = false;
    setDetailInspector({
      loading: true,
      result: null,
    });

    fetch(buildBridgeUrl("/api/employee/status"), {
      method: "POST",
      headers: getBridgeHeaders(),
      body: JSON.stringify({
        workspacePath: detailMember.workspace,
      }),
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "观察结果加载失败");
        }
        return payload;
      })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setDetailInspector({
          loading: false,
          result: payload.status?.inspector ?? null,
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setDetailInspector({
          loading: false,
          result: null,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [detailHistoryRefreshToken, detailMember?.workspace, getBridgeHeaders]);

  useEffect(() => {
    if (!detailMember?.workspace) {
      return;
    }

    let cancelled = false;
    setDetailProjects({
      items: [],
      loading: true,
    });

    fetch(buildBridgeUrl("/api/workspace/projects"), {
      method: "POST",
      headers: getBridgeHeaders(),
      body: JSON.stringify({
        workspacePath: detailMember.workspace,
      }),
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "项目空间加载失败");
        }
        return payload;
      })
      .then((payload) => {
        if (cancelled) {
          return;
        }

        setDetailProjects({
          items: Array.isArray(payload.projects) ? payload.projects : [],
          loading: false,
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setDetailProjects({
          items: [],
          loading: false,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [detailHistoryRefreshToken, detailMember?.workspace]);

  const isTerminalAttachable = useCallback(
    (member: RuntimeMember | null) =>
      Boolean(
        member &&
        member.runtimeStatus === "running" &&
        member.runtimeInfo?.sessionId,
      ),
    [],
  );

  const terminalMember = useMemo(
    () => findMemberById(terminalMemberId),
    [findMemberById, terminalMemberId],
  );
  const detailMemberIsRestarting = useMemo(
    () => Boolean(detailMemberId && restartingMemberIds.includes(detailMemberId)),
    [detailMemberId, restartingMemberIds],
  );

  const updateMember = useCallback(
    (memberId: string, updater: (current: RuntimeMember) => RuntimeMember) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === memberId
            ? {
                ...node,
                data: updater(node.data),
              }
            : node,
        ),
      );
    },
    [setNodes],
  );

  const visibleNodes = useMemo(
    () => {
      const companyScopedNodes =
        selectedCompany === "all"
          ? nodes
          : nodes.filter((node) => node.data.company === selectedCompany);

      if (runtimeFilter === "all") {
        return companyScopedNodes;
      }
      if (runtimeFilter === "recoveryPending") {
        return companyScopedNodes.filter((node) => node.data.recoveryPending);
      }
      if (runtimeFilter === "idle" || runtimeFilter === "busy" || runtimeFilter === "blocked") {
        return companyScopedNodes.filter((node) => node.data.workStatus === runtimeFilter);
      }
      return companyScopedNodes.filter((node) => node.data.runtimeStatus === runtimeFilter);
    },
    [nodes, runtimeFilter, selectedCompany],
  );

  const companyOptions = useMemo(
    () =>
      availableCompanies.length > 0
        ? availableCompanies
        : Array.from(
            new Set(nodes.map((node) => node.data.company).filter(Boolean)),
          ).sort((left, right) => left.localeCompare(right, "zh-CN")),
    [availableCompanies, nodes],
  );

  useEffect(() => {
    if (selectedCompany === "all") {
      return;
    }
    if (!companyOptions.includes(selectedCompany)) {
      setSelectedCompany("all");
    }
  }, [companyOptions, selectedCompany]);

  const companyScopedNodes = useMemo(
    () =>
      selectedCompany === "all"
        ? nodes
        : nodes.filter((node) => node.data.company === selectedCompany),
    [nodes, selectedCompany],
  );

  const handleEnterTerminal = useCallback(
    (memberId: string) => {
      const member = findMemberById(memberId);
      if (!member) {
        return;
      }
      if (restartingMemberIds.includes(memberId)) {
        setWorkspaceError("CLI 正在重启中，请稍后再进入终端");
        return;
      }

      if (!isTerminalAttachable(member)) {
        setWorkspaceError("当前没有活动中的 CLI 会话，请先重启 CLI 再进入终端");
        return;
      }

      setDetailMemberId(null);
      setTerminalMemberId(memberId);
    },
    [findMemberById, isTerminalAttachable, restartingMemberIds],
  );

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_, node) => {
      if (settings.directTerminalOpen) {
        handleEnterTerminal(node.id);
        return;
      }
      setDetailMemberId(node.id);
    },
    [handleEnterTerminal, settings.directTerminalOpen],
  );

  const handleStopRuntime = useCallback(
    async (memberId: string) => {
      const member = findMemberById(memberId);
      if (!member) {
        return;
      }

      setWorkspaceError("");
      try {
        const response = await fetch(buildBridgeUrl("/api/runtime/stop"), {
          method: "POST",
          headers: getBridgeHeaders(),
          body: JSON.stringify({
            cwd: member.workspace,
            memberId,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "停止 CLI 失败");
        }

        updateMember(memberId, (current) => ({
          ...current,
          diagnostics: [
            ...current.diagnostics.filter(
              (line: string) => !line.startsWith("session ") && !line.startsWith("pid "),
            ),
            "会话已停止",
          ],
          heartbeatLabel: "已停止",
          recoveryPending: false,
          runtimeInfo: {
            ...current.runtimeInfo,
            lastAction: "stop",
            pid: undefined,
            sessionId: "",
            status: "stopped",
            stoppedAt: new Date().toISOString(),
          },
          runtimeStatus: "stopped",
        }));
        setWorkspaceMessage(`已停止会话：${memberId}`);
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : "停止 CLI 失败");
      }
    },
    [findMemberById, updateMember],
  );

  const handleDeleteEmployee = useCallback(
    async (memberId: string) => {
      const member = findMemberById(memberId);
      if (!member) {
        setWorkspaceError("未找到目标员工");
        return false;
      }

      setWorkspaceError("");
      try {
        const response = await fetch(buildBridgeUrl("/api/employee/delete"), {
          method: "POST",
          headers: getBridgeHeaders(),
          body: JSON.stringify({
            workspacePath: member.workspace,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "辞退员工失败");
        }

        setNodes((current) => current.filter((node) => node.id !== memberId));
        setRestartingMemberIds((current) => current.filter((id) => id !== memberId));
        if (detailMemberId === memberId) {
          setDetailMemberId(null);
        }
        if (terminalMemberId === memberId) {
          setTerminalMemberId(null);
        }

        await refreshWorkspaceNodes({ silent: true });
        setWorkspaceMessage(`已辞退员工：${payload.employeeName ?? member.name}`);
        return true;
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : "辞退员工失败");
        return false;
      }
    },
    [
      detailMemberId,
      findMemberById,
      refreshWorkspaceNodes,
      terminalMemberId,
      setNodes,
    ],
  );

  const handleRestartRuntime = useCallback(
    async (memberId: string, workspaceOverride?: string) => {
      const member = findMemberById(memberId);
      if (!member) {
        return;
      }
      if (restartingMemberIds.includes(memberId)) {
        return;
      }

      setWorkspaceError("");
      setRestartingMemberIds((current) => [...current, memberId]);
      try {
        const nextWorkspace = workspaceOverride ?? member.workspace;
        const response = await fetch(buildBridgeUrl("/api/runtime/restart"), {
          method: "POST",
          headers: getBridgeHeaders(),
          body: JSON.stringify({
            cwd: nextWorkspace,
            memberId,
            permission: member.permission,
            shell: member.shell,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "重启 CLI 失败");
        }

        updateMember(memberId, (current) => ({
          ...current,
          diagnostics: [
            `session ${payload.sessionId}`,
            `pid ${payload.pid}`,
            ...current.diagnostics.filter(
              (line: string) => !line.startsWith("session ") && !line.startsWith("pid "),
            ),
          ],
          heartbeatLabel: payload.reused ? "已附着现有会话" : "CLI 已重启",
          projectName: extractProjectNameFromWorkspace(nextWorkspace),
          recoveryPending: false,
          runtimeInfo: {
            ...current.runtimeInfo,
            lastAction: "restart",
            pid: payload.pid,
            resolvedShell: payload.resolvedShell,
            sessionId: payload.sessionId,
            startedAt: payload.startedAt,
            status: "running",
            stoppedAt: null,
          },
          runtimeStatus: "running",
          workspace: nextWorkspace,
        }));
        setWorkspaceMessage(`已重启会话：${memberId}`);
        return payload as {
          launchMode?: string;
          pid?: number;
          resolvedShell?: string;
          reused?: boolean;
          sessionId?: string;
          startedAt?: string;
        };
      } catch (error) {
        updateMember(memberId, (current) => ({
          ...current,
          diagnostics: [
            `重启失败：${error instanceof Error ? error.message : "CLI 重启失败"}`,
            ...current.diagnostics.filter((line: string) => !line.startsWith("重启失败：")),
          ],
          heartbeatLabel: "异常待处理",
          recoveryPending: false,
          runtimeStatus: "error",
          workStatus: "blocked",
        }));
        setWorkspaceError(error instanceof Error ? error.message : "重启 CLI 失败");
        return null;
      } finally {
        setRestartingMemberIds((current) => current.filter((id) => id !== memberId));
      }
    },
    [findMemberById, restartingMemberIds, updateMember],
  );

  const handleStartRuntime = useCallback(
    async (memberId: string, workspaceOverride?: string) => {
      const member = findMemberById(memberId);
      if (!member) {
        throw new Error("未找到目标员工");
      }

      const nextWorkspace = workspaceOverride ?? member.workspace;
      const response = await fetch(buildBridgeUrl("/api/runtime/start"), {
        method: "POST",
        headers: getBridgeHeaders(),
        body: JSON.stringify({
          cwd: nextWorkspace,
          memberId,
          permission: member.permission,
          shell: member.shell,
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "启动 CLI 失败");
      }

      updateMember(memberId, (current) => ({
        ...current,
        diagnostics: [
          `session ${payload.sessionId}`,
          `pid ${payload.pid}`,
          ...current.diagnostics.filter(
            (line: string) => !line.startsWith("session ") && !line.startsWith("pid "),
          ),
        ],
        heartbeatLabel:
          payload.launchMode === "codex"
            ? "Codex 员工已启动"
            : payload.reused
              ? "已附着现有会话"
              : "CLI 已启动",
        projectName: extractProjectNameFromWorkspace(nextWorkspace),
        recoveryPending: false,
        runtimeInfo: {
          ...current.runtimeInfo,
          lastAction: "start",
          pid: payload.pid,
          resolvedShell: payload.resolvedShell,
          sessionId: payload.sessionId,
          startedAt: payload.startedAt,
          status: "running",
          stoppedAt: null,
        },
        runtimeStatus: "running",
        taskIntakeStatus:
          current.taskIntakeStatus === "pending_ack"
            ? "confirming"
            : current.taskIntakeStatus,
        workspace: nextWorkspace,
      }));

      return payload as {
        launchMode?: string;
        pid?: number;
        resolvedShell?: string;
        reused?: boolean;
        sessionId?: string;
        startedAt?: string;
      };
    },
    [findMemberById, updateMember],
  );

  const handlePublishTask = useCallback(
    async ({
      attachments,
      company,
      department,
      memberId,
      projectName,
      priority,
      source,
      taskDescription,
      timeWindow,
    }: {
      attachments: TaskReferenceAttachmentInput[];
      company: string;
      department: string;
      memberId: string;
      projectName: string;
      priority: "P0" | "P1" | "P2" | "P3";
      source: string;
      taskDescription: string;
      timeWindow:
        | "within_30m"
        | "within_1h"
        | "within_3h"
        | "within_12h"
        | "within_24h"
        | "no_deadline";
    }) => {
      const member = findMemberById(memberId);
      if (!member) {
        setWorkspaceError("未找到目标员工");
        return;
      }

      setWorkspaceError("");
      try {
        const response = await fetch(buildBridgeUrl("/api/task/assign"), {
          method: "POST",
          headers: getBridgeHeaders(),
          body: JSON.stringify({
            attachments,
            company,
            department,
            employeeName: member.name,
            forceCurrent: member.runtimeStatus !== "running",
            memberId,
            projectName,
            priority,
            source,
            taskDescription,
            timeWindow,
            workspacePath: member.workspace,
          }),
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "发布任务失败");
        }

        const taskSummary = String(payload.currentTask || taskDescription)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ?? taskDescription;

        updateMember(memberId, (current) => {
          const normalizedQueue = current.taskQueue.filter(
            (line) => !line.startsWith("项目 "),
          );

          return {
            ...current,
            currentTask:
              payload.mode === "current" || payload.mode === "project_switch"
                ? taskSummary
                : current.currentTask,
            diagnostics: [
              `收到任务：${taskSummary} [${priority}]`,
              ...current.diagnostics.filter((line) => !line.startsWith("收到任务：")),
            ],
            nextAction:
              payload.mode === "current" || payload.mode === "project_switch"
                ? "先确认任务并生成计划"
                : "当前任务完成后处理新任务",
            projectName:
              payload.mode === "project_switch" && payload.projectName
                ? payload.projectName
                : current.projectName,
            taskDeadline: payload.deadlineAt || null,
            taskIntakeStatus: "pending_ack",
            taskPriority: priority,
            taskSource: source,
            taskTimeWindow: timeWindow,
            taskQueue:
              payload.mode === "queued"
                ? [...normalizedQueue, taskSummary]
                : normalizedQueue,
            workStatus:
              payload.mode === "current" || payload.mode === "project_switch"
                ? "busy"
                : current.workStatus,
            workspace:
              payload.mode === "project_switch" && payload.switchWorkspacePath
                ? payload.switchWorkspacePath
                : current.workspace,
          };
        });

        let launchMessage = "";
        if (payload.mode === "project_switch" && payload.switchWorkspacePath) {
          const launchPayload =
            member.runtimeStatus === "running"
              ? await handleRestartRuntime(memberId, payload.switchWorkspacePath)
              : await handleStartRuntime(memberId, payload.switchWorkspacePath);
          launchMessage =
            launchPayload?.launchMode === "codex"
              ? "并已切换到目标项目启动 Codex 员工"
              : "并已切换到目标项目启动 CLI";
        } else if (member.runtimeStatus !== "running") {
          const launchPayload = await handleStartRuntime(memberId);
          launchMessage =
            launchPayload.launchMode === "codex"
              ? "并已自动启动 Codex 员工"
              : "并已自动启动 CLI";
        }

        setPublishTaskOpen(false);
        setHasPublishedOnboardingTask(true);
        setWorkspaceMessage(
          payload.mode === "queued_project"
            ? `任务已写入 ${projectName}，等待 ${member.name} 完成当前项目后切换`
            : `任务已发布给 ${member.name}${launchMessage}`,
        );
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : "发布任务失败");
      }
    },
    [findMemberById, handleRestartRuntime, handleStartRuntime, updateMember],
  );

  const handleCompleteTask = useCallback(
    async (memberId: string) => {
      const member = findMemberById(memberId);
      if (!member) {
        setWorkspaceError("未找到目标员工");
        return;
      }

      try {
        const response = await fetch(buildBridgeUrl("/api/task/complete"), {
          method: "POST",
          headers: getBridgeHeaders(),
          body: JSON.stringify({
            workspacePath: member.workspace,
          }),
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "完成任务失败");
        }

        let message = `已归档任务：${payload.completedTask}`;
        if (payload.switchWorkspacePath) {
          if (member.runtimeStatus === "running") {
            await handleRestartRuntime(memberId, payload.switchWorkspacePath);
          } else {
            await handleStartRuntime(memberId, payload.switchWorkspacePath);
          }
          message = `已完成当前任务，并切换到项目 ${payload.switchProjectName || extractProjectNameFromWorkspace(payload.switchWorkspacePath)}`;
        }

        setWorkspaceMessage(message);
        await refreshWorkspaceNodes({ silent: true });
        setDetailHistoryRefreshToken((current) => current + 1);
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : "完成任务失败");
      }
    },
    [findMemberById, handleRestartRuntime, handleStartRuntime, refreshWorkspaceNodes],
  );

  const handleCopyText = useCallback((value: string, label: string) => {
    if (!value) {
      setWorkspaceError(`${label}为空，无法复制`);
      return;
    }

    navigator.clipboard
      .writeText(value)
      .then(() => setWorkspaceMessage(`已复制${label}`))
      .catch(() => setWorkspaceError(`复制${label}失败`));
  }, []);

  const handleRunInspector = useCallback(
    async (memberId: string) => {
      const member = findMemberById(memberId);
      if (!member) {
        setWorkspaceError("未找到目标员工");
        return;
      }

      try {
        const response = await fetch(buildBridgeUrl("/api/inspector/review"), {
          method: "POST",
          headers: getBridgeHeaders(),
          body: JSON.stringify({
            memberId,
            workspacePath: member.workspace,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "观察者检查失败");
        }
        setDetailInspector({
          loading: false,
          result: payload.result ?? null,
        });
        setWorkspaceMessage("观察者已重新检查当前员工");
        await refreshWorkspaceNodes({ silent: true });
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : "观察者检查失败");
      }
    },
    [findMemberById, getBridgeHeaders, refreshWorkspaceNodes],
  );

  const handleSendInspectorReply = useCallback(
    async (memberId: string, replyText: string) => {
      const member = findMemberById(memberId);
      if (!member) {
        setWorkspaceError("未找到目标员工");
        return;
      }

      try {
        const response = await fetch(buildBridgeUrl("/api/inspector/reply"), {
          method: "POST",
          headers: getBridgeHeaders(),
          body: JSON.stringify({
            memberId,
            replyText,
            workspacePath: member.workspace,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "发送建议失败");
        }
        setWorkspaceMessage(`已发送建议给 ${member.name}`);
        await refreshPendingPrompts();
        await refreshWorkspaceNodes({ silent: true });
        setDetailHistoryRefreshToken((current) => current + 1);
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : "发送建议失败");
      }
    },
    [findMemberById, getBridgeHeaders, refreshPendingPrompts, refreshWorkspaceNodes],
  );

  const requestOpenLocalPath = useCallback(
    async (targetPath: string) => {
      const response = await fetch(buildBridgeUrl("/api/path/open"), {
        method: "POST",
        headers: getBridgeHeaders(),
        body: JSON.stringify({ path: targetPath }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "打开路径失败");
      }
      return payload;
    },
    [],
  );

  const handleOpenWorkspace = useCallback(
    async (memberId: string) => {
      const member = findMemberById(memberId);
      if (!member) {
        return;
      }

      try {
        await requestOpenLocalPath(member.workspace);
        setWorkspaceMessage(`已打开工作空间：${member.workspace}`);
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : "打开工作空间失败");
      }
    },
    [findMemberById, requestOpenLocalPath],
  );

  const handleOpenPath = useCallback(
    async (targetPath: string, label: string) => {
      try {
        await requestOpenLocalPath(targetPath);
        setWorkspaceMessage(`已打开 ${label}：${targetPath}`);
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : `打开 ${label} 失败`);
      }
    },
    [requestOpenLocalPath],
  );

  const handleDownloadHistoryFile = useCallback(
    (filePath: string, workspacePath?: string | null) => {
      const downloadUrl = buildBridgeDownloadUrl(
        "/api/download/file",
        {
          path: filePath,
          workspacePath: workspacePath ?? undefined,
        },
        apiSecurityRef.current,
      );

      triggerBrowserDownload(downloadUrl);
      setWorkspaceMessage(`开始下载：${filePath.split("/").pop() ?? "交付物文件"}`);
    },
    [triggerBrowserDownload],
  );

  const handleDownloadProjectHistoryBundle = useCallback(
    (workspacePath: string, projectName: string) => {
      const downloadUrl = buildBridgeDownloadUrl(
        "/api/download/archive",
        {
          scope: "project",
          workspacePath,
        },
        apiSecurityRef.current,
      );

      triggerBrowserDownload(downloadUrl);
      setWorkspaceMessage(`开始下载项目成果包：${projectName}`);
    },
    [triggerBrowserDownload],
  );

  const handleDownloadEmployeeHistoryBundle = useCallback(
    (workspacePath: string) => {
      const member = findMemberById(detailMemberId);
      const downloadUrl = buildBridgeDownloadUrl(
        "/api/download/archive",
        {
          scope: "employee",
          workspacePath,
        },
        apiSecurityRef.current,
      );

      triggerBrowserDownload(downloadUrl);
      setWorkspaceMessage(`开始下载全部成果包：${member?.name ?? "当前员工"}`);
    },
    [detailMemberId, findMemberById, triggerBrowserDownload],
  );

  const handleOpenWorkspaceFile = useCallback(
    async (memberId: string, filename: string, label: string) => {
      const member = findMemberById(memberId);
      if (!member) {
        return;
      }

      try {
        const filePath = `${member.workspace}/${filename}`;
        await handleOpenPath(filePath, label);
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : `打开 ${label} 失败`);
      }
    },
    [findMemberById, handleOpenPath],
  );

  const handleOpenEmployeeAgentFile = useCallback(
    async (memberId: string) => {
      const member = findMemberById(memberId);
      if (!member) {
        return;
      }

      const employeeRoot = member.workspace.replace(/[\\/]+$/, "").split(/[\\/]/).slice(0, -1).join("/");
      const candidate = `${employeeRoot}/EMPLOYEE_AGENT.md`;

      try {
        await requestOpenLocalPath(candidate);
        setWorkspaceMessage(`已打开 EMPLOYEE_AGENT.md：${candidate}`);
      } catch {
        setWorkspaceError("打开 EMPLOYEE_AGENT.md 失败");
      }
    },
    [findMemberById, requestOpenLocalPath],
  );

  const handleOpenRoleFile = useCallback(
    async (memberId: string) => {
      void handleOpenEmployeeAgentFile(memberId);
    },
    [handleOpenEmployeeAgentFile],
  );

  const handleOpenWorkspaceRulesFile = useCallback(
    async (memberId: string) => {
      const member = findMemberById(memberId);
      if (!member) {
        return;
      }

      try {
        await requestOpenLocalPath(`${member.workspace}/AGENTS.md`);
        setWorkspaceMessage(`已打开 AGENTS.md：${member.workspace}/AGENTS.md`);
      } catch {
        setWorkspaceError("打开 AGENTS.md 失败");
      }
    },
    [findMemberById, requestOpenLocalPath],
  );

  const handleUpdateMemberSettings = useCallback(
    async (
      memberId: string,
      settings: {
        autoTrustWorkspace: boolean;
        elevationMode: RuntimeMember["automationSettings"]["elevationMode"];
        permission: string;
        promptAutomation: RuntimeMember["automationSettings"]["promptAutomation"];
      },
    ) => {
      const member = findMemberById(memberId);
      if (!member) {
        setWorkspaceError("未找到目标员工");
        return;
      }

      try {
        const response = await fetch(buildBridgeUrl("/api/workspace/member-config"), {
          method: "POST",
          headers: getBridgeHeaders(),
          body: JSON.stringify({
            autoTrustWorkspace: settings.autoTrustWorkspace,
            elevationMode: settings.elevationMode,
            memberId,
            permission: settings.permission,
            promptAutomation: settings.promptAutomation,
            workspacePath: member.workspace,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "保存员工策略失败");
        }

        updateMember(memberId, (current) => ({
          ...current,
          automationSettings: {
            autoTrustWorkspace: settings.autoTrustWorkspace,
            elevationMode: settings.elevationMode,
            promptAutomation: settings.promptAutomation,
          },
          permission: settings.permission,
        }));
        setWorkspaceMessage("员工运行策略已保存，权限模式将在下次重启 CLI 后生效");
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : "保存员工策略失败");
      }
    },
    [findMemberById, updateMember],
  );

  const handleSwitchProjectSpace = useCallback(
    async (memberId: string, targetWorkspacePath: string) => {
      const member = findMemberById(memberId);
      if (!member) {
        setWorkspaceError("未找到目标员工");
        return;
      }

      try {
        const response = await fetch(buildBridgeUrl("/api/employee/projects/switch"), {
          method: "POST",
          headers: getBridgeHeaders(),
          body: JSON.stringify({
            targetWorkspacePath,
            workspacePath: member.workspace,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "切换项目失败");
        }

        if (payload.mode === "blocked_active_task") {
          setWorkspaceError(
            `当前项目仍有任务进行中：${payload.currentTask}，请完成后再切换`,
          );
          return;
        }

        if (payload.mode === "switched") {
          if (member.runtimeStatus === "running") {
            await handleRestartRuntime(memberId, payload.workspacePath);
          } else {
            await handleStartRuntime(memberId, payload.workspacePath);
          }
          await refreshWorkspaceNodes({ silent: true });
          setDetailHistoryRefreshToken((current) => current + 1);
          setWorkspaceMessage(`已切换到项目 ${payload.projectName}`);
          return;
        }

        setWorkspaceMessage(`当前已在项目 ${payload.projectName}`);
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : "切换项目失败");
      }
    },
    [findMemberById, getBridgeHeaders, handleRestartRuntime, handleStartRuntime, refreshWorkspaceNodes],
  );

  const handleRespondPendingPrompt = useCallback(
    async (
      promptId: string,
      action: "approve" | "reject" | "continue" | "dismiss",
    ) => {
      try {
        const response = await fetch(buildBridgeUrl("/api/runtime/prompts/respond"), {
          method: "POST",
          headers: getBridgeHeaders(),
          body: JSON.stringify({
            action,
            promptId,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "处理审核消息失败");
        }

        await refreshPendingPrompts();
        await refreshWorkspaceNodes({ silent: true });
        setDetailHistoryRefreshToken((current) => current + 1);
        setWorkspaceMessage("审核消息已处理");
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : "处理审核消息失败");
      }
    },
    [refreshPendingPrompts, refreshWorkspaceNodes],
  );

  const handleAddPromptRule = useCallback(() => {
    setPromptRulesState((current) => ({
      ...current,
      rules: [...current.rules, createEmptyPromptRule(current.rules.length)],
    }));
  }, []);

  const handlePromptRuleChange = useCallback((ruleId: string, patch: Partial<PromptRule>) => {
    setPromptRulesState((current) => ({
      ...current,
      rules: current.rules.map((rule) =>
        rule.id === ruleId
          ? {
              ...rule,
              ...patch,
            }
          : rule,
      ),
    }));
  }, []);

  const handleDeletePromptRule = useCallback((ruleId: string) => {
    setPromptRulesState((current) => ({
      ...current,
      rules: current.rules.filter((rule) => rule.id !== ruleId),
    }));
  }, []);

  const handleSavePromptRules = useCallback(async () => {
    setPromptRulesState((current) => ({
      ...current,
      error: "",
      saving: true,
    }));

    try {
      const response = await fetch(buildBridgeUrl("/api/settings/prompt-rules/save"), {
        method: "POST",
        headers: getBridgeHeaders(),
        body: JSON.stringify({
          projectRoot: settings.projectPath,
          rules: promptRulesState.rules,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "提示白名单保存失败");
      }

      setPromptRulesState((current) => ({
        ...current,
        filePath: payload.filePath ?? current.filePath,
        rules: Array.isArray(payload.rules) ? payload.rules : current.rules,
        saving: false,
      }));
      setWorkspaceMessage("提示白名单已保存");
    } catch (error) {
      setPromptRulesState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "提示白名单保存失败",
        saving: false,
      }));
      setWorkspaceError(error instanceof Error ? error.message : "提示白名单保存失败");
    }
  }, [promptRulesState.rules, settings.projectPath]);

  const handleInspectorSettingsChange = useCallback((next: InspectorSettings) => {
    setInspectorSettingsState((current) => ({
      ...current,
      error: "",
      settings: next,
    }));
  }, []);

  const handleSaveInspectorSettings = useCallback(async () => {
    setInspectorSettingsState((current) => ({
      ...current,
      error: "",
      saving: true,
    }));

    try {
      const response = await fetch(buildBridgeUrl("/api/settings/inspector/save"), {
        method: "POST",
        headers: getBridgeHeaders(),
        body: JSON.stringify({
          projectRoot: settings.projectPath,
          settings: inspectorSettingsState.settings,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "观察者配置保存失败");
      }

      setInspectorSettingsState((current) => ({
        ...current,
        filePath: payload.filePath ?? current.filePath,
        saving: false,
        settings: payload.settings ?? current.settings,
        testError: "",
      }));
      setWorkspaceMessage("观察者配置已保存");
    } catch (error) {
      setInspectorSettingsState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "观察者配置保存失败",
        saving: false,
      }));
      setWorkspaceError(error instanceof Error ? error.message : "观察者配置保存失败");
    }
  }, [getBridgeHeaders, inspectorSettingsState.settings, settings.projectPath]);

  const handleTestInspectorSettings = useCallback(async () => {
    setInspectorSettingsState((current) => ({
      ...current,
      testError: "",
      testLatencyMs: null,
      testMessage: "",
      testModels: [],
      testing: true,
    }));

    try {
      const response = await fetch(buildBridgeUrl("/api/settings/inspector/test"), {
        method: "POST",
        headers: getBridgeHeaders(),
        body: JSON.stringify({
          projectRoot: settings.projectPath,
          settings: inspectorSettingsState.settings,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Inspector AI 连通性测试失败");
      }

      setInspectorSettingsState((current) => ({
        ...current,
        testError: "",
        testLatencyMs: typeof payload.latencyMs === "number" ? payload.latencyMs : null,
        testMessage: payload.message ?? "Inspector 连接成功",
        testModels: Array.isArray(payload.models) ? payload.models : [],
        testing: false,
      }));
      setWorkspaceMessage("Inspector AI 连通性测试成功");
    } catch (error) {
      setInspectorSettingsState((current) => ({
        ...current,
        testError: error instanceof Error ? error.message : "Inspector AI 连通性测试失败",
        testing: false,
      }));
      setWorkspaceError(error instanceof Error ? error.message : "Inspector AI 连通性测试失败");
    }
  }, [getBridgeHeaders, inspectorSettingsState.settings, settings.projectPath]);

  const handleApiSecurityChange = useCallback((patch: { apiKey?: string; enabled?: boolean }) => {
    setApiSecurity((current) => ({
      ...current,
      ...patch,
      error: "",
    }));
  }, []);

  const handleGenerateApiKey = useCallback(() => {
    setApiSecurity((current) => ({
      ...current,
      apiKey: generateApiKeyValue(),
      error: "",
    }));
  }, []);

  const handleSaveApiSecurity = useCallback(async () => {
    setApiSecurity((current) => ({
      ...current,
      error: "",
      saving: true,
    }));

    try {
      const response = await fetch(buildBridgeUrl("/api/settings/security/save"), {
        method: "POST",
        headers: getBridgeHeaders(),
        body: JSON.stringify({
          apiKey: apiSecurity.apiKey,
          enabled: apiSecurity.enabled,
          projectRoot: settings.projectPath,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "API 鉴权配置保存失败");
      }

      setApiSecurity((current) => ({
        ...current,
        enabled: Boolean(payload.enabled),
        error: "",
        filePath: payload.filePath ?? current.filePath,
        saving: false,
      }));
      setWorkspaceMessage(
        payload.enabled ? "本地 API 鉴权已启用" : "本地 API 鉴权已关闭",
      );
    } catch (error) {
      setApiSecurity((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "API 鉴权配置保存失败",
        saving: false,
      }));
      setWorkspaceError(error instanceof Error ? error.message : "API 鉴权配置保存失败");
    }
  }, [apiSecurity.apiKey, apiSecurity.enabled, getBridgeHeaders, settings.projectPath]);

  const handleCreateEmployee = useCallback(
    async (form: NewEmployeeForm) => {
      const baseMember = createRuntimeMember(form, nodes.length);
      setWorkspaceError("");
      setWorkspaceMessage("");

      const duplicate = nodes.find(
        (node) =>
          node.data.name === baseMember.name ||
          node.data.employeeCode === baseMember.employeeCode,
      );
      if (duplicate) {
        setWorkspaceError("员工名称或员工编号已存在，请调整后再创建");
        return;
      }

      try {
        const projectRoot = form.workspace.replace(/[\\/]+$/, "");
        const response = await fetch(buildBridgeUrl("/api/workspace/init"), {
          method: "POST",
          headers: getBridgeHeaders(),
          body: JSON.stringify({
            agentDefinitionText: form.agentDefinitionText,
            company: form.company,
            department: form.department,
            employeeCode: form.employeeCode,
            employeeName: form.name,
            autoTrustWorkspace: form.autoTrustWorkspace,
            elevationMode: form.elevationMode,
            memberId: baseMember.id,
            permission: form.permission,
            promptAutomation: form.promptAutomation,
            projectName: form.projectName,
            projectRoot,
            repoSource: form.repoSource,
            role: form.role,
            shell: form.shell,
            systemAgentEnabled: form.systemAgentEnabled,
          }),
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "成员工作空间初始化失败");
        }

        const runtimeResponse = await fetch(buildBridgeUrl("/api/runtime/start"), {
          method: "POST",
          headers: getBridgeHeaders(),
          body: JSON.stringify({
            cwd: payload.workspacePath,
            memberId: baseMember.id,
            permission: form.permission,
            shell: form.shell,
          }),
        });

        const runtimePayload = await runtimeResponse.json();
        if (!runtimeResponse.ok) {
          throw new Error(runtimePayload.error || "成员 CLI 启动失败");
        }

        const member = {
          ...baseMember,
          diagnostics: [
            `session ${runtimePayload.sessionId}`,
            `pid ${runtimePayload.pid}`,
            ...baseMember.diagnostics,
          ],
          heartbeatLabel: runtimePayload.reused ? "已附着现有会话" : "CLI 已启动",
          recoveryPending: false,
          runtimeInfo: {
            pid: runtimePayload.pid,
            resolvedShell: runtimePayload.resolvedShell,
            sessionId: runtimePayload.sessionId,
            startedAt: runtimePayload.startedAt,
          },
          runtimeStatus: "running" as const,
          workStatus: "idle" as const,
          workspace: payload.workspacePath,
        };

        startTransition(() => {
          setNodes((current) => [...current, createRuntimeNode(member, current.length)]);
          setAddEmployeeOpen(false);
        });
        setWorkspaceMessage(`已创建并启动：${payload.workspacePath}`);
      } catch (error) {
        setWorkspaceError(
          error instanceof Error ? error.message : "成员创建失败",
        );
      }
    },
    [nodes.length, setNodes],
  );

  const totalCount = companyScopedNodes.length;
  const runningCount = companyScopedNodes.filter((node) => node.data.runtimeStatus === "running").length;
  const stoppedCount = companyScopedNodes.filter((node) => node.data.runtimeStatus === "stopped").length;
  const errorCount = companyScopedNodes.filter((node) => node.data.runtimeStatus === "error").length;

  const filterOptions: Array<{
    activeClass: string;
    count: number;
    inactiveClass: string;
    label: string;
    value: RuntimeFilter;
  }> = [
    {
      activeClass: "btn-primary",
      count: totalCount,
      inactiveClass: "btn-outline",
      label: "全部",
      value: "all",
    },
    {
      activeClass: "btn-success",
      count: runningCount,
      inactiveClass: "btn-outline btn-success",
      label: "运行中",
      value: "running",
    },
    {
      activeClass: "btn-neutral",
      count: stoppedCount,
      inactiveClass: "btn-outline btn-neutral",
      label: "已停止",
      value: "stopped",
    },
    {
      activeClass: "btn-error",
      count: errorCount,
      inactiveClass: "btn-outline btn-error",
      label: "异常",
      value: "error",
    },
  ];

  return (
    <div className="min-h-screen bg-shell-app text-shell-text">
      <div className="mx-auto flex min-h-screen max-w-[1680px] flex-col px-6 py-5">
        {workspaceMessage ? (
          <div className="toast toast-top toast-end z-[90]">
            <div className="alert alert-success">
              <span>{workspaceMessage}</span>
            </div>
          </div>
        ) : null}

        {workspaceError ? (
          <div className="toast toast-top toast-end z-[90]">
            <div className="alert alert-error">
              <span>{workspaceError}</span>
            </div>
          </div>
        ) : null}

        <header className="navbar rounded-box border border-base-300 bg-base-100 px-5 shadow-sm">
          <div className="flex-1">
            <div className="space-y-1.5">
              <p className="text-[22px] font-semibold tracking-tight">WH 调度台</p>
              <p className="text-xs text-shell-muted">
              牛马的传承，由 AI 续写
              </p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <CompanyFilterDropdown
              companies={companyOptions}
              onChange={setSelectedCompany}
              onToggle={setCompanyDropdownOpen}
              open={companyDropdownOpen}
              value={selectedCompany}
            />
            <button
              className="btn btn-outline btn-sm gap-2 px-4"
              onClick={() => setPendingPromptsOpen(true)}
              type="button"
            >
              审核消息
              {pendingPrompts.length > 0 ? (
                <span className="badge badge-error badge-sm">{pendingPrompts.length}</span>
              ) : null}
            </button>
            <button
              className="btn btn-secondary btn-sm px-4"
              onClick={() => setPublishTaskOpen(true)}
              type="button"
            >
              发布任务
            </button>
            <button
              className="btn btn-primary btn-sm px-4"
              onClick={() => setAddEmployeeOpen(true)}
              type="button"
            >
              添加员工
            </button>
            <button
              className="btn btn-outline btn-sm px-4"
              onClick={() => void refreshWorkspaceNodes()}
              type="button"
            >
              扫描员工
            </button>

            <div className="dropdown dropdown-end">
              <button className="btn btn-ghost btn-circle btn-sm" type="button">
                <svg
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.8"
                  viewBox="0 0 24 24"
                >
                  <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.527-.94 3.31.844 2.37 2.37a1.724 1.724 0 0 0 1.065 2.573c1.757.426 1.757 2.924 0 3.35a1.724 1.724 0 0 0-1.065 2.573c.94 1.526-.843 3.31-2.37 2.37a1.724 1.724 0 0 0-2.573 1.065c-.426 1.757-2.924 1.757-3.35 0a1.724 1.724 0 0 0-2.573-1.065c-1.526.94-3.31-.844-2.37-2.37a1.724 1.724 0 0 0-1.065-2.573c-1.757-.426-1.757-2.924 0-3.35a1.724 1.724 0 0 0 1.065-2.573c-.94-1.526.844-3.31 2.37-2.37.996.613 2.296.07 2.573-1.066z" />
                  <path d="M12 15.5A3.5 3.5 0 1 0 12 8.5a3.5 3.5 0 0 0 0 7z" />
                </svg>
              </button>
              <ul className="menu dropdown-content z-[80] mt-2 w-64 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
                <li>
                  <button
                    onClick={() => {
                      setOnboardingOpen(true);
                      void loadCodexSettings();
                    }}
                    type="button"
                  >
                    首次引导
                  </button>
                </li>
                <li>
                  <button onClick={() => setSettingsOpen(true)} type="button">
                    打开设置
                  </button>
                </li>
                <li>
                  <button
                    onClick={() => setSettings((current) => ({ ...current, theme: "light" }))}
                    type="button"
                  >
                    切换到 Light
                  </button>
                </li>
                <li>
                  <button
                    onClick={() => setSettings((current) => ({ ...current, theme: "dark" }))}
                    type="button"
                  >
                    切换到 Dark
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </header>

        <section className="mt-5 min-h-0 flex-1">
          <div className="card border border-base-300 bg-base-200 shadow-sm">
            <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-4 rounded-t-box border-b border-base-300 bg-base-100/90 px-5 py-3 backdrop-blur">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-shell-text">运行终端画布</p>
                  <button
                    className="btn btn-ghost btn-circle btn-xs"
                    onClick={() => setStatusGuideOpen(true)}
                    type="button"
                  >
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="1.8"
                      viewBox="0 0 24 24"
                    >
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 10v6" />
                      <path d="M12 7.25h.01" />
                    </svg>
                  </button>
                </div>
                <p className="text-xs text-shell-muted">
                  点击任意员工卡片查看终端详情，再从弹窗进入终端交互
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {filterOptions.map((option) => {
                  const active = runtimeFilter === option.value;

                  return (
                    <button
                      key={option.value}
                      className={`btn btn-sm gap-2 px-3 ${
                        active ? option.activeClass : option.inactiveClass
                      }`}
                      onClick={() =>
                        setRuntimeFilter((current) =>
                          option.value === "all"
                            ? "all"
                            : current === option.value
                              ? "all"
                              : option.value,
                        )
                      }
                      type="button"
                    >
                      <span>{option.count}</span>
                      <span>{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="h-[calc(100vh-158px)] w-full bg-[length:24px_24px] bg-canvas-grid pt-16">
              <ReactFlow
                fitView
                nodes={visibleNodes}
                edges={[]}
                nodeTypes={nodeTypes}
                onNodeClick={onNodeClick}
                onNodesChange={onNodesChange}
                minZoom={0.45}
                maxZoom={1.4}
              >
                <Background
                  color="rgba(124, 138, 160, 0.1)"
                  gap={28}
                  size={1.1}
                  variant={BackgroundVariant.Dots}
                />
                <MiniMap
                  bgColor="oklch(var(--b2))"
                  maskColor="oklch(var(--bc) / 0.08)"
                  nodeBorderRadius={12}
                  nodeColor={(node) => {
                    const status = node.data?.runtimeStatus;
                    const workStatus = node.data?.workStatus;
                    const recoveryPending = node.data?.recoveryPending;

                    if (status === "error") {
                      return "oklch(var(--er))";
                    }
                    if (status === "running" && workStatus === "blocked") {
                      return "oklch(var(--wa))";
                    }
                    if (status === "running" && workStatus === "busy") {
                      return "oklch(var(--in))";
                    }
                    if (status === "running") {
                      return "oklch(var(--su))";
                    }
                    if (recoveryPending) {
                      return "oklch(var(--s))";
                    }
                    return "oklch(var(--b3))";
                  }}
                  nodeStrokeColor={(node) => {
                    const status = node.data?.runtimeStatus;
                    const workStatus = node.data?.workStatus;
                    const recoveryPending = node.data?.recoveryPending;

                    if (status === "error") {
                      return "oklch(var(--er) / 0.7)";
                    }
                    if (status === "running" && workStatus === "blocked") {
                      return "oklch(var(--wa) / 0.7)";
                    }
                    if (status === "running" && workStatus === "busy") {
                      return "oklch(var(--in) / 0.7)";
                    }
                    if (status === "running") {
                      return "oklch(var(--su) / 0.7)";
                    }
                    if (recoveryPending) {
                      return "oklch(var(--s) / 0.7)";
                    }
                    return "oklch(var(--bc) / 0.18)";
                  }}
                  pannable
                  zoomable
                />
                <Controls showInteractive={false} />
                <Panel position="top-left">
                  <div className="flex flex-col gap-2">
                    <div className="badge badge-outline px-3 py-3 text-xs">
                      画布无上下级关系，仅展示当前员工 CLI
                    </div>
                    {selectedCompany !== "all" ? (
                      <div className="badge badge-outline px-3 py-3 text-xs">
                        当前公司：{selectedCompany}
                      </div>
                    ) : null}
                    {runtimeFilter !== "all" ? (
                      <div className="badge badge-primary badge-outline px-3 py-3 text-xs">
                        当前筛选：{filterOptions.find((option) => option.value === runtimeFilter)?.label}
                      </div>
                    ) : null}
                    {visibleNodes.length === 0 ? (
                      <div className="badge badge-outline px-3 py-3 text-xs">
                        当前筛选下暂无员工
                      </div>
                    ) : null}
                  </div>
                </Panel>
              </ReactFlow>
            </div>
          </div>
        </section>
      </div>

      <RuntimeDetailModal
        canEnterTerminal={isTerminalAttachable(detailMember)}
        projectSpaces={detailProjects.items}
        projectSpacesLoading={detailProjects.loading}
        inspectorLoading={detailInspector.loading}
        inspectorResult={detailInspector.result}
        isRestarting={detailMemberIsRestarting}
        onRestartRuntime={handleRestartRuntime}
        member={detailMember}
        onClose={() => setDetailMemberId(null)}
        onDownloadEmployeeHistoryBundle={handleDownloadEmployeeHistoryBundle}
        onDownloadHistoryFile={handleDownloadHistoryFile}
        onDownloadProjectHistoryBundle={handleDownloadProjectHistoryBundle}
        onOpenRoleFile={handleOpenRoleFile}
        onOpenTaskRequestFile={(memberId) => {
          void handleOpenWorkspaceFile(memberId, "task_request.md", "task_request.md");
        }}
        onOpenWorkspaceRulesFile={(memberId) => {
          void handleOpenWorkspaceRulesFile(memberId);
        }}
        onCopySessionId={(memberId) => {
          const member = findMemberById(memberId);
          handleCopyText(member?.runtimeInfo?.sessionId ?? "", "sessionId");
        }}
        onCopyWorkspace={(memberId) => {
          const member = findMemberById(memberId);
          handleCopyText(member?.workspace ?? "", "工作空间路径");
        }}
        onEnterTerminal={handleEnterTerminal}
        onCompleteTask={handleCompleteTask}
        historyArtifacts={detailHistory.artifacts}
        historyFinished={detailHistory.finished}
        historyLoading={detailHistory.loading}
        onOpenHistoryFile={(filePath) => {
          void handleOpenPath(filePath, filePath.split("/").pop() ?? "交付物文件");
        }}
        onOpenHistoryFolder={(folderPath) => {
          void handleOpenPath(folderPath, "交付物文件夹");
        }}
        onOpenProjectWorkspace={(workspacePath) => {
          void handleOpenPath(workspacePath, "项目空间");
        }}
        onOpenWorkspace={handleOpenWorkspace}
        onSwitchProjectSpace={handleSwitchProjectSpace}
        onDeleteEmployee={handleDeleteEmployee}
        onRunInspector={handleRunInspector}
        onSendInspectorReply={handleSendInspectorReply}
        onStopRuntime={handleStopRuntime}
        onUpdateMemberSettings={handleUpdateMemberSettings}
      />

      <PendingPromptsModal
        onClose={() => setPendingPromptsOpen(false)}
        onEnterTerminal={handleEnterTerminal}
        onRespond={handleRespondPendingPrompt}
        logs={promptHandlingLogs.map((log) => {
          const member = findMemberById(log.memberId);
          return {
            ...log,
            memberLabel: member ? `${member.name} · ${member.company}` : log.memberId,
          };
        })}
        open={pendingPromptsOpen}
        prompts={pendingPrompts.map((prompt) => {
          const member = findMemberById(prompt.memberId);
          return {
            ...prompt,
            memberLabel: member ? `${member.name} · ${member.company}` : prompt.memberId,
          };
        })}
      />

      <StatusGuideModal
        onClose={() => setStatusGuideOpen(false)}
        open={statusGuideOpen}
      />

      <Suspense
        fallback={
          terminalMember ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#020617]/72 backdrop-blur-sm">
              <div className="card border border-base-300 bg-base-100 px-6 py-5 text-sm text-shell-muted shadow-sm">
                正在加载终端窗口...
              </div>
            </div>
          ) : null
        }
      >
        <TerminalWindow
          apiKey={apiSecurity.apiKey}
          apiKeyEnabled={apiSecurity.enabled}
          bridgeWsOrigin={BRIDGE_WS_ORIGIN}
          member={terminalMember}
          onClose={() => setTerminalMemberId(null)}
          terminalFontSize={settings.terminalFontSize}
        />
      </Suspense>

      <AddEmployeeModal
        agentRepoState={agentRepoState}
        defaults={{
          agentRepoUrl: settings.agentRepoUrl,
          defaultCompany: settings.defaultCompany,
          defaultDepartment: settings.defaultDepartment,
          defaultPermission: settings.defaultPermission,
          defaultProjectStrategy: settings.defaultProjectStrategy,
          defaultShell: settings.defaultShell,
          projectPath: settings.projectPath,
        }}
        onClose={() => setAddEmployeeOpen(false)}
        onConfirm={handleCreateEmployee}
        onSyncAgentRepo={syncAgentRepo}
        open={addEmployeeOpen}
      />

      <PublishTaskModal
        defaultProjectStrategy={settings.defaultProjectStrategy}
        members={nodes.map((node) => node.data)}
        onClose={() => setPublishTaskOpen(false)}
        onConfirm={handlePublishTask}
        open={publishTaskOpen}
        preferredCompany={selectedCompany === "all" ? undefined : selectedCompany}
      />

      <OnboardingModal
        codexState={codexSettingsState}
        hasEmployees={hasEmployees}
        hasPublishedTask={hasPublishedTask}
        onChangeAuth={handleCodexAuthChange}
        onChangeConfig={handleCodexConfigChange}
        onChangeConfigToml={handleCodexConfigTomlChange}
        onClose={() => {
          setOnboardingOpen(false);
          setHasDismissedOnboarding(true);
        }}
        onFinish={() => {
          setOnboardingOpen(false);
          setHasDismissedOnboarding(true);
        }}
        onOpenAddEmployee={() => {
          setOnboardingChildFlow("employee");
          setAddEmployeeOpen(true);
        }}
        onOpenPublishTask={() => {
          setOnboardingChildFlow("task");
          setPublishTaskOpen(true);
        }}
        onSaveCodex={handleSaveCodexSettings}
        onTestCodex={handleTestCodexSettings}
        open={onboardingOpen}
      />

      <SettingsModal
        apiSecurityState={apiSecurity}
        codexSettingsState={codexSettingsState}
        inspectorSettingsState={inspectorSettingsState}
        onApiSecurityChange={handleApiSecurityChange}
        onAddPromptRule={handleAddPromptRule}
        onCodexAuthChange={handleCodexAuthChange}
        onCodexConfigChange={handleCodexConfigChange}
        onCodexConfigTomlChange={handleCodexConfigTomlChange}
        onClose={() => setSettingsOpen(false)}
        onDeletePromptRule={handleDeletePromptRule}
        onGenerateApiKey={handleGenerateApiKey}
        onInspectorSettingsChange={handleInspectorSettingsChange}
        onPromptRuleChange={handlePromptRuleChange}
        onSave={setSettings}
        onSaveApiSecurity={handleSaveApiSecurity}
        onSaveCodexSettings={handleSaveCodexSettings}
        onSaveInspectorSettings={handleSaveInspectorSettings}
        onSavePromptRules={handleSavePromptRules}
        onTestCodexSettings={handleTestCodexSettings}
        onTestInspectorSettings={handleTestInspectorSettings}
        onSyncRepo={() => void syncAgentRepo(true)}
        open={settingsOpen}
        promptRulesState={promptRulesState}
        repoCacheRoot={agentRepoCacheRoot}
        repoSyncState={{
          commit: agentRepoState.commit,
          error: agentRepoState.error,
          lastSyncedAt: agentRepoState.lastSyncedAt,
          loading: agentRepoState.loading,
          warning: agentRepoState.warning,
        }}
        settings={settings}
      />
    </div>
  );
}

export default App;
