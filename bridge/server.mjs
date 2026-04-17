import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createReadStream, existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import archiver from "archiver";

const execFileAsync = promisify(execFile);
const BRIDGE_HOST = process.env.CCLIENT_BRIDGE_HOST || "127.0.0.1";
const BRIDGE_PORT = Number(process.env.CCLIENT_BRIDGE_PORT || 4281);
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const HISTORY_LIMIT = 800;
const AGENT_REPO_CACHE_ROOT = path.join(process.cwd(), ".cache", "agent-repos");
const DEFAULT_AGENT_REPO_FALLBACK = path.join(process.cwd(), ".tmp-agent-repo");
const SESSION_EPOCH = 1735689600000n;
const SESSION_WORKER_ID = BigInt(process.pid % 32);
const STARTUP_ACK_TIMEOUT_MS = 30000;

const sessions = new Map();
const pendingPrompts = new Map();
const promptHandlingLogs = [];
let sessionSequence = 0n;
const PROMPT_LOG_LIMIT = 80;
let activeSecurityConfig = {
  apiKey: "",
  enabled: false,
  filePath: "",
  projectRoot: "",
};

function defaultAutomationSettings() {
  return {
    autoTrustWorkspace: true,
    elevationMode: "manual",
    promptAutomation: "safe_auto",
  };
}

function deriveProjectRootFromWorkspace(workspacePath) {
  let current = String(workspacePath || "").replace(/[\\/]+$/, "");
  for (let index = 0; index < 4; index += 1) {
    current = path.dirname(current);
  }
  return current;
}

function deriveProjectRootFromEmployeeRoot(employeeRoot) {
  let current = String(employeeRoot || "").replace(/[\\/]+$/, "");
  for (let index = 0; index < 3; index += 1) {
    current = path.dirname(current);
  }
  return current;
}

function securityFilePath(projectRoot) {
  return path.join(projectRoot, "setting", "security.json");
}

function settingsRootPath(projectRoot) {
  return path.join(projectRoot, "setting");
}

function deriveProjectRootFromCacheRoot(cacheRoot) {
  const normalized = String(cacheRoot || "").replace(/[\\/]+$/, "");
  if (!normalized) {
    return "";
  }

  return path.dirname(path.dirname(normalized));
}

function resolveProjectRootFromPayload(payload) {
  return (
    String(payload?.projectRoot || "").trim() ||
    (payload?.workspacePath ? deriveProjectRootFromWorkspace(payload.workspacePath) : "") ||
    (payload?.cwd ? deriveProjectRootFromWorkspace(payload.cwd) : "") ||
    (payload?.cacheRoot ? deriveProjectRootFromCacheRoot(payload.cacheRoot) : "") ||
    activeSecurityConfig.projectRoot
  );
}

function getSettingsRootState(payload) {
  const fallbackRoot =
    activeSecurityConfig.projectRoot ||
    String(process.env.CCLIENT_PUBLIC_DEFAULT_PROJECT_PATH || "").trim() ||
    String(process.env.VITE_DEFAULT_PROJECT_PATH || "").trim() ||
    process.cwd();
  const normalizedRoot = String(resolveProjectRootFromPayload(payload) || fallbackRoot).replace(/[\\/]+$/, "");
  if (!normalizedRoot) {
    throw new Error("projectRoot is unavailable");
  }

  const settingsRoot = settingsRootPath(normalizedRoot);
  const templatesRoot = path.join(settingsRoot, "templates");
  const promptRulesPath = promptRulesFilePath(normalizedRoot);
  const securityPath = securityFilePath(normalizedRoot);
  const agentRepoCacheRoot = path.join(settingsRoot, "agent-repo");

  return {
    agentRepoCacheRoot: agentRepoCacheRoot.replace(/\\/g, "/"),
    projectRoot: normalizedRoot.replace(/\\/g, "/"),
    projectRootExists: existsSync(normalizedRoot),
    promptRulesFilePath: promptRulesPath.replace(/\\/g, "/"),
    securityFilePath: securityPath.replace(/\\/g, "/"),
    settingsRoot: settingsRoot.replace(/\\/g, "/"),
    settingsRootExists: existsSync(settingsRoot),
    templatesRoot: templatesRoot.replace(/\\/g, "/"),
    templatesRootExists: existsSync(templatesRoot),
  };
}

async function loadSecurityConfig(projectRoot) {
  const normalizedRoot = String(projectRoot || "").replace(/[\\/]+$/, "");
  if (!normalizedRoot) {
    return activeSecurityConfig;
  }

  const filePath = securityFilePath(normalizedRoot);
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    activeSecurityConfig = {
      apiKey: String(parsed.apiKey || ""),
      enabled: Boolean(parsed.enabled),
      filePath: filePath.replace(/\\/g, "/"),
      projectRoot: normalizedRoot.replace(/\\/g, "/"),
    };
    return activeSecurityConfig;
  } catch {
    activeSecurityConfig = {
      apiKey: "",
      enabled: false,
      filePath: filePath.replace(/\\/g, "/"),
      projectRoot: normalizedRoot.replace(/\\/g, "/"),
    };
    return activeSecurityConfig;
  }
}

async function saveSecurityConfig(projectRoot, payload, providedKey) {
  const normalizedRoot = String(projectRoot || "").replace(/[\\/]+$/, "");
  if (!normalizedRoot) {
    throw new Error("projectRoot is required");
  }

  const currentConfig = await loadSecurityConfig(normalizedRoot);
  if (currentConfig.enabled && currentConfig.apiKey && currentConfig.apiKey !== providedKey) {
    throw new Error("invalid api key");
  }

  const nextConfig = {
    apiKey: String(payload.apiKey || "").trim(),
    enabled: Boolean(payload.enabled) && Boolean(String(payload.apiKey || "").trim()),
  };
  const filePath = securityFilePath(normalizedRoot);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  activeSecurityConfig = {
    ...nextConfig,
    filePath: filePath.replace(/\\/g, "/"),
    projectRoot: normalizedRoot.replace(/\\/g, "/"),
  };
  return activeSecurityConfig;
}

async function resolveSecurityConfigForPayload(payload) {
  const projectRoot = resolveProjectRootFromPayload(payload);

  return loadSecurityConfig(projectRoot);
}

function extractProvidedApiKey(request, url = null) {
  const headerValue = request.headers["x-cclient-key"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }

  if (Array.isArray(headerValue) && headerValue[0]?.trim()) {
    return headerValue[0].trim();
  }

  const token = url?.searchParams.get("token");
  return token?.trim() || "";
}

async function ensureAuthorizedRequest(request, payload, url = null) {
  const securityConfig = await resolveSecurityConfigForPayload(payload);
  if (!securityConfig.enabled) {
    return securityConfig;
  }

  const providedKey = extractProvidedApiKey(request, url);
  if (!providedKey || providedKey !== securityConfig.apiKey) {
    throw new Error("invalid api key");
  }

  return securityConfig;
}

function promptRulesFilePath(projectRoot) {
  return path.join(projectRoot, "setting", "prompt-rules.json");
}

function sanitizePromptRule(rawRule, index) {
  return {
    action: String(rawRule?.action || "route_pending"),
    enabled: rawRule?.enabled !== false,
    id: String(rawRule?.id || `prompt-rule-${Date.now()}-${index}`),
    name: String(rawRule?.name || `规则 ${index + 1}`),
    pattern: String(rawRule?.pattern || "").trim(),
  };
}

async function loadPromptRules(projectRoot) {
  const normalizedRoot = String(projectRoot || "").replace(/[\\/]+$/, "");
  const filePath = promptRulesFilePath(normalizedRoot);

  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    return {
      filePath: filePath.replace(/\\/g, "/"),
      rules: Array.isArray(parsed?.rules)
        ? parsed.rules.map((rule, index) => sanitizePromptRule(rule, index))
        : [],
    };
  } catch {
    return {
      filePath: filePath.replace(/\\/g, "/"),
      rules: [],
    };
  }
}

async function savePromptRules(projectRoot, rules) {
  const normalizedRoot = String(projectRoot || "").replace(/[\\/]+$/, "");
  if (!normalizedRoot) {
    throw new Error("projectRoot is required");
  }

  const settingDir = path.join(normalizedRoot, "setting");
  const filePath = promptRulesFilePath(normalizedRoot);
  const normalizedRules = Array.isArray(rules)
    ? rules
        .map((rule, index) => sanitizePromptRule(rule, index))
        .filter((rule) => rule.pattern)
    : [];

  await mkdir(settingDir, { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ rules: normalizedRules }, null, 2)}\n`,
    "utf8",
  );

  return {
    filePath: filePath.replace(/\\/g, "/"),
    rules: normalizedRules,
  };
}

function defaultCodexConfigValues() {
  return {
    authMode: "apikey",
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
    wireApi: "responses",
    windowsWslSetupAcknowledged: true,
  };
}

function resolveCodexHomeDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function codexConfigPaths() {
  const codexHome = resolveCodexHomeDir();
  return {
    authPath: path.join(codexHome, "auth.json"),
    codexHome,
    configPath: path.join(codexHome, "config.toml"),
  };
}

function parseTomlPrimitive(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return "";
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  if (/^".*"$/.test(value)) {
    return value.slice(1, -1).replace(/\\"/g, "\"");
  }
  return value;
}

function parseCodexConfigToml(content) {
  const defaults = defaultCodexConfigValues();
  const parsed = { ...defaults };
  let section = "";

  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = parseTomlPrimitive(line.slice(separatorIndex + 1));

    if (!section) {
      if (key === "model_provider") {
        parsed.modelProvider = String(value || defaults.modelProvider);
      } else if (key === "model") {
        parsed.model = String(value || defaults.model);
      } else if (key === "review_model") {
        parsed.reviewModel = String(value || defaults.reviewModel);
      } else if (key === "model_reasoning_effort") {
        parsed.modelReasoningEffort = String(value || defaults.modelReasoningEffort);
      } else if (key === "disable_response_storage") {
        parsed.disableResponseStorage = Boolean(value);
      } else if (key === "network_access") {
        parsed.networkAccess = String(value || defaults.networkAccess);
      } else if (key === "windows_wsl_setup_acknowledged") {
        parsed.windowsWslSetupAcknowledged = Boolean(value);
      } else if (key === "model_context_window") {
        parsed.modelContextWindow = Number(value || defaults.modelContextWindow);
      } else if (key === "model_auto_compact_token_limit") {
        parsed.modelAutoCompactTokenLimit = Number(
          value || defaults.modelAutoCompactTokenLimit,
        );
      }
      continue;
    }

    if (section === "model_providers.custom") {
      if (key === "name") {
        parsed.providerName = String(value || defaults.providerName);
      } else if (key === "wire_api") {
        parsed.wireApi = String(value || defaults.wireApi);
      } else if (key === "base_url") {
        parsed.baseUrl = String(value || defaults.baseUrl);
      }
    }
  }

  return parsed;
}

function buildCodexConfigToml(config) {
  const normalized = {
    ...defaultCodexConfigValues(),
    ...(config || {}),
  };

  return [
    `model_provider = "${normalized.modelProvider}"`,
    `model = "${normalized.model}"`,
    `review_model = "${normalized.reviewModel}"`,
    `model_reasoning_effort = "${normalized.modelReasoningEffort}"`,
    `disable_response_storage = ${normalized.disableResponseStorage ? "true" : "false"}`,
    `network_access = "${normalized.networkAccess}"`,
    `windows_wsl_setup_acknowledged = ${normalized.windowsWslSetupAcknowledged ? "true" : "false"}`,
    `model_context_window = ${Number(normalized.modelContextWindow) || defaultCodexConfigValues().modelContextWindow}`,
    `model_auto_compact_token_limit = ${Number(normalized.modelAutoCompactTokenLimit) || defaultCodexConfigValues().modelAutoCompactTokenLimit}`,
    "",
    "[model_providers.custom]",
    `name = "${normalized.providerName}"`,
    `wire_api = "${normalized.wireApi}"`,
    `base_url = "${normalized.baseUrl}"`,
    "",
  ].join("\n");
}

function normalizeCodexAuth(payload) {
  return {
    OPENAI_API_KEY: String(payload?.OPENAI_API_KEY || payload?.apiKey || "").trim(),
    authMode: String(payload?.auth_mode || payload?.authMode || "apikey").trim() || "apikey",
  };
}

async function loadCodexSettings() {
  const defaults = defaultCodexConfigValues();
  const { authPath, codexHome, configPath } = codexConfigPaths();
  const [configTomlRaw, authJsonRaw, codexCommandAvailable] = await Promise.all([
    readFile(configPath, "utf8").catch(() => ""),
    readFile(authPath, "utf8").catch(() => ""),
    commandExists("codex"),
  ]);

  const parsedConfig = configTomlRaw ? parseCodexConfigToml(configTomlRaw) : defaults;
  let parsedAuth = normalizeCodexAuth({});

  if (authJsonRaw) {
    try {
      parsedAuth = normalizeCodexAuth(JSON.parse(authJsonRaw));
    } catch {
      parsedAuth = normalizeCodexAuth({});
    }
  }

  return {
    auth: parsedAuth,
    authJson:
      authJsonRaw ||
      `${JSON.stringify(
        {
          OPENAI_API_KEY: parsedAuth.OPENAI_API_KEY,
          auth_mode: parsedAuth.authMode,
        },
        null,
        2,
      )}\n`,
    authPath: authPath.replace(/\\/g, "/"),
    codexCommandAvailable,
    codexHome: codexHome.replace(/\\/g, "/"),
    configured: Boolean(parsedConfig.baseUrl && parsedAuth.OPENAI_API_KEY),
    config: parsedConfig,
    configPath: configPath.replace(/\\/g, "/"),
    configToml: configTomlRaw || buildCodexConfigToml(parsedConfig),
  };
}

async function saveCodexSettings(payload) {
  const { authPath, codexHome, configPath } = codexConfigPaths();
  const normalizedConfig = {
    ...defaultCodexConfigValues(),
    ...(payload?.config || {}),
  };
  const normalizedAuth = normalizeCodexAuth(payload?.auth || {});
  const nextConfigToml =
    typeof payload?.configToml === "string" && payload.configToml.trim()
      ? payload.configToml.replace(/\r\n/g, "\n").trimEnd() + "\n"
      : buildCodexConfigToml(normalizedConfig);
  const nextAuthJson = `${JSON.stringify(
    {
      OPENAI_API_KEY: normalizedAuth.OPENAI_API_KEY,
      auth_mode: normalizedAuth.authMode,
    },
    null,
    2,
  )}\n`;

  await mkdir(codexHome, { recursive: true });
  await writeFile(configPath, nextConfigToml, "utf8");
  await writeFile(authPath, nextAuthJson, "utf8");

  return loadCodexSettings();
}

function buildCodexAuthHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function testCodexSettings(payload) {
  const config =
    typeof payload?.configToml === "string" && payload.configToml.trim()
      ? {
          ...defaultCodexConfigValues(),
          ...parseCodexConfigToml(payload.configToml),
        }
      : {
          ...defaultCodexConfigValues(),
          ...(payload?.config || {}),
        };
  const auth = normalizeCodexAuth(payload?.auth || {});
  const baseUrl = String(config.baseUrl || "").replace(/\/+$/, "");

  if (!baseUrl) {
    throw new Error("base_url 不能为空");
  }
  if (!auth.OPENAI_API_KEY) {
    throw new Error("API Key 不能为空");
  }

  const startedAt = Date.now();
  const modelsUrl = `${baseUrl}/models`;
  const response = await fetch(modelsUrl, {
    headers: buildCodexAuthHeaders(auth.OPENAI_API_KEY),
    method: "GET",
  });
  const latencyMs = Date.now() - startedAt;
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `连通性测试失败：${response.status} ${response.statusText}${text ? ` · ${text.slice(0, 240)}` : ""}`,
    );
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  const models = Array.isArray(parsed?.data)
    ? parsed.data
        .map((item) => String(item?.id || "").trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];

  return {
    latencyMs,
    message: models.length > 0 ? `连接成功，已识别 ${models.length} 个模型` : "连接成功",
    modelCount: Array.isArray(parsed?.data) ? parsed.data.length : 0,
    models,
    ok: true,
    testedUrl: modelsUrl,
  };
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Headers": "Content-Type, X-CClient-Key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

function createCorsHeaders(extraHeaders = {}) {
  return {
    "Access-Control-Allow-Headers": "Content-Type, X-CClient-Key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  };
}

function sanitizeDownloadName(value, fallback = "download") {
  const normalized = String(value || "").trim();
  const sanitized = normalized.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").trim();
  return sanitized || fallback;
}

function buildContentDisposition(filename) {
  const utf8Name = sanitizeDownloadName(filename);
  const asciiFallback = utf8Name.replace(/[^\x20-\x7E]+/g, "_");
  return `attachment; filename="${asciiFallback || "download"}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`;
}

function guessContentType(filePath) {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  switch (extension) {
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function deriveEmployeeNameFromWorkspace(workspacePath) {
  return path.basename(deriveEmployeeRootFromWorkspace(workspacePath)) || "employee";
}

async function streamFileDownload(response, filePath, downloadName) {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    throw new Error("目标文件不存在");
  }

  response.writeHead(
    200,
    createCorsHeaders({
      "Cache-Control": "no-store",
      "Content-Disposition": buildContentDisposition(downloadName || path.basename(filePath)),
      "Content-Length": fileStat.size,
      "Content-Type": guessContentType(filePath),
    }),
  );

  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    response.on("close", resolve);
    response.on("finish", resolve);
    stream.pipe(response);
  });
}

function sanitizePathSegment(segment) {
  return String(segment).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").trim() || "unnamed";
}

function bigIntToBase32(value) {
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  if (value === 0n) {
    return "0";
  }

  let next = value;
  let result = "";
  while (next > 0n) {
    const digit = Number(next % 32n);
    result = alphabet[digit] + result;
    next /= 32n;
  }

  return result;
}

function createSessionId() {
  const timestamp = BigInt(Date.now()) - SESSION_EPOCH;
  sessionSequence = (sessionSequence + 1n) % 4096n;
  const value = (timestamp << 17n) | (SESSION_WORKER_ID << 12n) | (sessionSequence & 4095n);
  return `sess-${bigIntToBase32(value)}`;
}

async function ensureTextFile(filePath, content) {
  try {
    await access(filePath);
  } catch {
    await writeFile(filePath, content, "utf8");
  }
}

function buildDefaultPlanMarkdown(payload, createdAt) {
  return `# 规划文件

## 基础信息

- 公司：${payload.company ?? ""}
- 部门：${payload.department ?? ""}
- 员工：${payload.employeeName ?? ""}
- 项目：${payload.projectName ?? ""}
- 创建时间：${createdAt}

## 当前目标

- 待补充

## 拆解步骤

- 校验当前工作空间、Agent 定义与基础上下文
- 按任务推进更新 current.md / wait_finished.md / finished.md / block.md
- 记录关键产出物与阻塞原因

## 客户端后续规划

1. 运行态真实性：补齐 CLI 存活探测、异常归因与恢复策略
2. 工作态来源：让忙碌中 / 阻塞中 / 空闲有真实状态来源
3. 项目空间入口：补齐 current.md、block.md、finished.md、runtime/meta.json 快捷入口
4. 运行控制完善：增强批量扫描、恢复、停止与重启能力
5. 服务端协议预埋：统一 HTTP / WebSocket 接口模型，方便后续接入服务端
6. 持久化补强：继续完善会话、节点布局和筛选状态持久化

## 备注

- 本文件可按实际任务持续更新
`;
}

function buildWorkspaceGuideMarkdown(payload, createdAt) {
  return `# 工作说明书

## 你的身份

- 公司：${payload.company ?? ""}
- 部门：${payload.department ?? ""}
- 员工：${payload.employeeName ?? ""}
- 项目：${payload.projectName ?? ""}
- 初始化时间：${createdAt}

你不是一个普通 shell。

你应该被视为：

- 应用了员工 Agent 定义的 Codex CLI 会话
- 在当前项目空间内长期工作的执行型员工
- 需要持续维护任务文件与产出物的实际工作单元

## 启动原则

客户端后续在启动 CLI 时，应默认完成以下动作：

1. 进入当前项目空间
2. 优先让 Codex 装载 \`AGENTS.md\`
3. 阅读 \`ROLE.md\`
4. 如需更详细的人类说明，再阅读本说明书 \`workspace_guide.md\`
5. 优先读取 \`current.md\`，其次读取 \`plan.md\`
6. 在当前任务基础上继续工作，而不是把自己当作一个空白终端

## 文件说明

- \`AGENTS.md\`
  当前项目空间内给 Codex 自动加载的长期规则文件，说明你应该如何维护这些任务文件与产出物

- \`ROLE.md\`
  员工角色定义快照，说明你是谁、擅长什么、边界是什么

- \`workspace_guide.md\`
  当前项目空间的补充说明文档，主要供人类或调试场景阅读

- \`task_request.md\`
  原始任务收件箱。外部发布给员工的需求应先写入这里，由员工自己解析并生成计划

- \`references/\`
  外部派发任务时附带的参考资料目录，可包含图片、文档、代码片段等输入材料

- \`startup_ack.md\`
  首轮确认文件。员工启动后应先写这里，确认自己已读取任务、是否已生成计划、下一步准备做什么

- \`plan.md\`
  任务拆解与执行规划。员工在阅读 \`task_request.md\` 后应先生成或更新这里

- \`current.md\`
  当前正在处理的任务与下一步动作。需要保持简洁且最新

- \`wait_finished.md\`
  待执行但未开始的任务列表

- \`finished.md\`
  已完成事项与结果摘要，建议追加记录，不要覆盖历史

- \`block.md\`
  阻塞记录。遇到阻塞必须记录原因、影响与需要的支持

- \`artifacts/\`
  真实产出物目录。报告、代码、截图、分析结果都应归档到这里

- \`runtime/meta.json\`
  运行时元数据，主要供客户端和服务端使用，不应被随意手工改写

## 更新规则

### 收到新任务时

1. 先阅读 \`task_request.md\`
2. 先更新 \`startup_ack.md\`，确认自己已接单并给出理解摘要
3. 再生成或更新 \`plan.md\`
4. 然后把当前执行项写入 \`current.md\`
5. 如果还有未开始事项，写入 \`wait_finished.md\`

### 执行过程中

1. 任务切换时，及时更新 \`current.md\`
2. 发现阻塞时，必须写入 \`block.md\`
3. 产出物应归档到 \`artifacts/\`

### 完成任务时

1. 将结果摘要追加到 \`finished.md\`
2. 将关键产出物放入 \`artifacts/\`
3. 清理或重写 \`current.md\`，确保它只反映最新状态

## 不应该做的事

- 不要把所有历史都堆进 \`current.md\`
- 不要覆盖 \`finished.md\` 既有记录
- 不要把业务产出写进 \`runtime/meta.json\`
- 不要忽略阻塞，阻塞必须进入 \`block.md\`

## 设计方向

后续客户端将沿着以下方向继续演进：

1. 员工实例不再是普通 PTY，而是带 Agent 定义与初始化上下文的 Codex 会话
2. 启动 CLI 时自动注入角色、项目空间语义和文件维护规则
3. 恢复时优先从 \`current.md\` 与 \`plan.md\` 恢复上下文，而不是依赖无限增长的历史对话
4. UI、本地 API 与未来服务端 WebSocket 共用同一套运行时模型

## 备注

- 本文件由客户端模板生成，可按项目实际情况补充，但不建议删除核心约定
`;
}

function buildWorkspaceAgentsTemplateMarkdown() {
  return `# AGENTS.md

你正在一个 C-CLIENT 员工项目空间内工作。

本文件对当前目录及其子目录全部生效。

## 启动规则

1. 先阅读 \`ROLE.md\`
2. 再阅读 \`task_request.md\`
3. 如存在待确认任务，先更新 \`startup_ack.md\`
4. 先生成或更新 \`plan.md\`，再执行具体工作
5. 不要把自己当成一个空白 shell，要基于当前文件继续推进

## 文件职责

- \`ROLE.md\`
  员工角色快照，描述这个员工是谁、擅长什么、工作边界是什么

- \`task_request.md\`
  原始需求输入。外部派发的新任务先写这里，再由你自行解析

- \`references/\`
  任务附带的参考资料目录。若 \`task_request.md\` 提到了这里的文件，应在规划前先阅读或查看

- \`startup_ack.md\`
  首轮确认文件。接单后应先更新这里，写清任务理解、计划状态和下一步动作

- \`plan.md\`
  任务拆解计划。先规划，再执行

- \`current.md\`
  当前正在处理的任务与下一步，必须保持最新且简洁

- \`wait_finished.md\`
  尚未开始的排队任务

- \`finished.md\`
  已完成事项的追加记录，不要覆盖历史

- \`block.md\`
  阻塞记录。遇到阻塞必须登记原因、影响和需要的支持

- \`artifacts/\`
  所有真实产出物都必须写到这里

## 工作约束

- 真实产出物必须进入 \`artifacts/\`
- 任务切换时及时更新 \`current.md\`
- 完成事项只追加到 \`finished.md\`
- 遇到阻塞必须写入 \`block.md\`
- 不要把业务产出写进 \`runtime/meta.json\`

## 交付习惯

- 优先给出简洁的任务摘要
- 先写计划，再动手执行
- 如果任务要求不清晰，先在 \`startup_ack.md\` 或 \`block.md\` 中说明
`;
}

function buildCodexBootstrapMarkdown(payload, createdAt) {
  return `你现在是一个已经应用了员工 Agent 定义的 Codex CLI 会话。

项目空间：

- 公司：${payload.company ?? ""}
- 部门：${payload.department ?? ""}
- 员工：${payload.employeeName ?? ""}
- 项目：${payload.projectName ?? ""}
- 初始化时间：${createdAt}

启动后必须遵循以下顺序：

1. 先确认 \`AGENTS.md\` 已被加载，并阅读 \`ROLE.md\`
2. 再阅读 \`task_request.md\`
3. 先更新 \`startup_ack.md\`，确认你已经完成任务理解
4. 再基于 \`task_request.md\` 生成或更新 \`plan.md\`
5. 严格按照 \`AGENTS.md\` 的要求维护 \`current.md\`、\`plan.md\`、\`wait_finished.md\`、\`finished.md\`、\`block.md\`
6. 所有真实产出物写入 \`artifacts/\`

你不是普通 shell，而是项目空间中的员工执行单元。

请先确认任务、写入 startup_ack.md、生成计划，再继续执行工作。
`;
}

function truncatePromptContent(content, maxChars = 4000) {
  const normalized = String(content).trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars)}\n...[内容已截断]`;
}

async function readWorkspacePromptSection(workspacePath, filename, maxChars = 4000) {
  const absolutePath = path.join(workspacePath, filename);

  try {
    const content = await readFile(absolutePath, "utf8");
    return `## ${filename}\n${truncatePromptContent(content, maxChars)}`;
  } catch {
    return `## ${filename}\n(文件不存在或尚未初始化)`;
  }
}

async function readWorkspaceFileContent(workspacePath, filename) {
  const absolutePath = path.join(workspacePath, filename);

  try {
    return await readFile(absolutePath, "utf8");
  } catch {
    return "";
  }
}

async function readRuntimeConfiguration(workspacePath) {
  const metaPath = path.join(workspacePath, "runtime", "meta.json");

  try {
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    const projectRoot = String(meta.projectRoot || "").trim() || deriveProjectRootFromWorkspace(workspacePath);
    const promptRules = await loadPromptRules(projectRoot);
    return {
      automationSettings: {
        autoTrustWorkspace: meta.autoTrustWorkspace !== false,
        elevationMode: meta.elevationMode ?? "manual",
        promptAutomation: meta.promptAutomation ?? "safe_auto",
      },
      projectRoot,
      promptRules: promptRules.rules,
    };
  } catch {
    const projectRoot = deriveProjectRootFromWorkspace(workspacePath);
    const promptRules = await loadPromptRules(projectRoot);
    return {
      automationSettings: defaultAutomationSettings(),
      projectRoot,
      promptRules: promptRules.rules,
    };
  }
}

function summarizeMarkdownTail(content, placeholderPattern) {
  const lines = extractMeaningfulTextLines(content);
  if (lines.length === 0) {
    return null;
  }

  const filtered = placeholderPattern
    ? lines.filter((line) => !placeholderPattern.test(line))
    : lines;

  if (filtered.length === 0) {
    return null;
  }

  return filtered[filtered.length - 1] ?? null;
}

async function findLatestArtifact(workspacePath) {
  const artifactsDir = path.join(workspacePath, "artifacts");
  if (!existsSync(artifactsDir)) {
    return null;
  }

  const queue = [artifactsDir];
  let latestFile = null;
  let latestMtime = 0;

  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir) {
      continue;
    }

    let entries = [];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      try {
        const fileStat = await stat(absolutePath);
        const mtime = fileStat.mtimeMs;
        if (mtime > latestMtime) {
          latestMtime = mtime;
          latestFile = absolutePath;
        }
      } catch {
        // ignore file stat errors
      }
    }
  }

  if (!latestFile) {
    return null;
  }

  return path.relative(artifactsDir, latestFile).replace(/\\/g, "/");
}

async function listArtifactEntries(workspacePath) {
  const artifactsDir = path.join(workspacePath, "artifacts");
  if (!existsSync(artifactsDir)) {
    return [];
  }

  const queue = [artifactsDir];
  const files = [];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir) {
      continue;
    }

    let entries = [];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      try {
        const fileStat = await stat(absolutePath);
        files.push({
          detail: path.relative(artifactsDir, absolutePath).replace(/\\/g, "/"),
          filePath: absolutePath.replace(/\\/g, "/"),
          folderPath: path.dirname(absolutePath).replace(/\\/g, "/"),
          id: `artifact:${absolutePath.replace(/\\/g, "/")}`,
          kind: "artifact",
          modifiedAt: fileStat.mtime.toISOString(),
          title: path.basename(absolutePath),
        });
      } catch {
        // ignore file stat errors
      }
    }
  }

  return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

function summarizeFinishedLine(line) {
  return String(line)
    .replace(/^- /, "")
    .replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s+/, "")
    .split("：")[0]
    .trim();
}

function buildLegacyFinishedDetail(line) {
  const artifactMatch = String(line).match(/artifacts\/([^\s，,]+)/i);
  if (artifactMatch?.[1]) {
    return `归档：artifacts/${artifactMatch[1]}`;
  }

  return "完成记录";
}

function listLegacyFinishedEntries(workspacePath, content) {
  const lines = extractMeaningfulTextLines(content).filter((line) => !/暂无记录/.test(line));
  const groups = [];
  let currentGroup = null;

  for (const line of lines) {
    if (/^-?\s*\d{4}-\d{2}-\d{2}(T[^\s]+)?[:：]/.test(line)) {
      if (currentGroup) {
        groups.push(currentGroup);
      }

      currentGroup = {
        detailParts: [],
        titleLine: line,
      };
      continue;
    }

    if (!currentGroup) {
      currentGroup = {
        detailParts: [],
        titleLine: line,
      };
      continue;
    }

    currentGroup.detailParts.push(line.replace(/^- /, "").trim());
  }

  if (currentGroup) {
    groups.push(currentGroup);
  }

  return groups.reverse().map((group, index) => ({
    detail: group.detailParts.join(" · ") || buildLegacyFinishedDetail(group.titleLine),
    filePath: null,
    folderPath: path.join(workspacePath, "artifacts").replace(/\\/g, "/"),
    id: `finished:${workspacePath}:legacy:${index}`,
    kind: "finished",
    modifiedAt: null,
    projectName: deriveProjectNameFromWorkspace(workspacePath),
    title: summarizeFinishedLine(group.titleLine),
    workspacePath: workspacePath.replace(/\\/g, "/"),
  }));
}

function listFinishedEntries(workspacePath, content) {
  const sections = parseMarkdownSections(content);

  if (sections.length > 0) {
    return sections
      .map((section, index) => {
        const lines = extractMeaningfulTextLines(section.body);
        const task = parseTaskMetadataFromContent(section.body);
        const artifactRef = getTaskField(lines, "归档");
        const detailParts = [];
        const modifiedAtMatch = String(section.title || "").match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/);

        if (artifactRef) {
          detailParts.push(`归档：${artifactRef}`);
        }
        if (task.source) {
          detailParts.push(`来源：${task.source}`);
        }
        if (task.timeWindow) {
          detailParts.push(`窗口：${task.timeWindow}`);
        }
        if (task.deadlineAt) {
          detailParts.push(`截止：${task.deadlineAt}`);
        }

        return {
          detail: detailParts.join(" · ") || "完成记录",
          filePath: null,
          folderPath: path.join(workspacePath, "artifacts").replace(/\\/g, "/"),
          id: `finished:${workspacePath}:${index}`,
          kind: "finished",
          modifiedAt: modifiedAtMatch?.[1] ?? null,
          title:
            (task.summary || "").replace(/^- /, "").trim() ||
            String(section.title || "")
              .replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s+/, "")
              .trim() ||
            "已完成任务",
        };
      })
      .sort((left, right) => (right.modifiedAt ?? "").localeCompare(left.modifiedAt ?? ""));
  }

  const lines = extractMeaningfulTextLines(content)
    .filter((line) => !/暂无记录/.test(line))
    .reverse();

  if (lines.some((line) => /^-?\s*\d{4}-\d{2}-\d{2}/.test(line))) {
    return listLegacyFinishedEntries(workspacePath, content);
  }

  return lines.map((line, index) => ({
    detail: buildLegacyFinishedDetail(line),
    filePath: null,
    folderPath: path.join(workspacePath, "artifacts").replace(/\\/g, "/"),
    id: `finished:${workspacePath}:legacy:${index}`,
    kind: "finished",
    modifiedAt: null,
    projectName: deriveProjectNameFromWorkspace(workspacePath),
    title: summarizeFinishedLine(line),
    workspacePath: workspacePath.replace(/\\/g, "/"),
  }));
}

function deriveArtifactFolderPath(filePath) {
  return path.dirname(String(filePath || "")).replace(/\\/g, "/");
}

async function listEmployeeDeliveryEntries(workspacePath) {
  const employeeRoot = deriveEmployeeRootFromWorkspace(workspacePath);
  const files = employeeRootFiles(employeeRoot);
  const current = await readJsonFile(files.deliveriesIndexPath, {
    items: [],
    updatedAt: null,
  });
  const items = Array.isArray(current.items) ? current.items : [];

  return items
    .filter((item) => item?.filePath)
    .map((item, index) => ({
      detail: item.filePath.replace(/\\/g, "/"),
      filePath: item.filePath.replace(/\\/g, "/"),
      folderPath: deriveArtifactFolderPath(item.filePath),
      id: `delivery-index:${employeeRoot.replace(/\\/g, "/")}:${index}`,
      kind: "artifact",
      modifiedAt: item.completedAt ?? null,
      projectName: item.projectName ?? deriveProjectNameFromWorkspace(item.workspacePath || ""),
      title: item.title ?? path.basename(item.filePath),
      workspacePath: String(item.workspacePath || "").replace(/\\/g, "/"),
    }))
    .sort((left, right) => (right.modifiedAt ?? "").localeCompare(left.modifiedAt ?? ""));
}

async function listEmployeeProjectWorkspaces(workspacePath) {
  const employeeRoot = deriveEmployeeRootFromWorkspace(workspacePath);
  let entries = [];
  try {
    entries = await readdir(employeeRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidate = path.join(employeeRoot, entry.name);
    if (existsSync(path.join(candidate, "runtime", "meta.json"))) {
      projects.push(candidate);
    }
  }

  return projects;
}

async function listWorkspaceHistory(workspacePath) {
  const normalizedWorkspace = String(workspacePath || "").replace(/[\\/]+$/, "");
  if (!normalizedWorkspace) {
    throw new Error("workspacePath is required");
  }

  const indexedEntries = await listEmployeeDeliveryEntries(normalizedWorkspace);
  if (indexedEntries.length > 0) {
    return {
      artifacts: indexedEntries.slice(0, 50),
      finished: [],
    };
  }

  const projectWorkspaces = await listEmployeeProjectWorkspaces(normalizedWorkspace);
  const targetWorkspaces = projectWorkspaces.length > 0 ? projectWorkspaces : [normalizedWorkspace];

  const historyGroups = await Promise.all(
    targetWorkspaces.map(async (projectWorkspace) => {
      const [artifactEntries, finishedContent] = await Promise.all([
        listArtifactEntries(projectWorkspace),
        readWorkspaceFileContent(projectWorkspace, "finished.md"),
      ]);

      return {
        artifacts: artifactEntries.map((entry) => ({
          ...entry,
          projectName: deriveProjectNameFromWorkspace(projectWorkspace),
          workspacePath: projectWorkspace.replace(/\\/g, "/"),
        })),
        finished: listFinishedEntries(projectWorkspace, finishedContent),
      };
    }),
  );

  return {
    artifacts: historyGroups.flatMap((group) => group.artifacts).slice(0, 100),
    finished: historyGroups.flatMap((group) => group.finished).slice(0, 100),
  };
}

function hasBlockRecord(content) {
  const lines = extractMeaningfulTextLines(content);
  if (lines.length === 0) {
    return false;
  }

  return !lines.every((line) => /暂无阻塞/.test(line));
}

async function listEmployeeProjectSpaces(workspacePath) {
  const normalizedWorkspace = String(workspacePath || "").replace(/[\\/]+$/, "");
  if (!normalizedWorkspace) {
    throw new Error("workspacePath is required");
  }

  const employeeRoot = deriveEmployeeRootFromWorkspace(normalizedWorkspace);
  const files = employeeRootFiles(employeeRoot);
  const [projectWorkspaces, currentProjectPointer, dispatchQueue] = await Promise.all([
    listEmployeeProjectWorkspaces(normalizedWorkspace),
    readJsonFile(files.currentProjectPath, null),
    readJsonFile(files.dispatchQueuePath, { items: [] }),
  ]);

  const queueItems = Array.isArray(dispatchQueue?.items) ? dispatchQueue.items : [];
  const entries = await Promise.all(
    projectWorkspaces.map(async (projectWorkspace) => {
      const normalizedProjectWorkspace = projectWorkspace.replace(/\\/g, "/");
      const [currentContent, blockContent, meta, currentStat] = await Promise.all([
        readWorkspaceFileContent(projectWorkspace, "current.md"),
        readWorkspaceFileContent(projectWorkspace, "block.md"),
        readJsonFile(path.join(projectWorkspace, "runtime", "meta.json"), {}),
        stat(path.join(projectWorkspace, "current.md")).catch(() => null),
      ]);

      const currentTaskState = parseCurrentTaskState(currentContent);
      const queueItem = queueItems.find(
        (item) =>
          String(item?.workspacePath || "").replace(/\\/g, "/").toLowerCase() ===
          normalizedProjectWorkspace.toLowerCase(),
      );
      const isCurrent =
        String(currentProjectPointer?.workspacePath || "").replace(/\\/g, "/").toLowerCase() ===
        normalizedProjectWorkspace.toLowerCase();
      const blocked = hasBlockRecord(blockContent);
      const status =
        isCurrent
          ? "当前项目"
          : queueItem
            ? "排队中"
            : blocked
              ? "阻塞"
              : currentTaskState.currentTask !== "暂无"
                ? "有任务"
                : "空闲";

      return {
        currentTask: currentTaskState.currentTask,
        isCurrent,
        nextAction: currentTaskState.nextAction,
        projectName: deriveProjectNameFromWorkspace(projectWorkspace),
        queued: Boolean(queueItem),
        status,
        updatedAt:
          currentStat?.mtime?.toISOString?.() ??
          meta.lastCompletedAt ??
          meta.lastAssignedAt ??
          meta.stoppedAt ??
          meta.startedAt ??
          meta.createdAt ??
          null,
        workspacePath: normalizedProjectWorkspace,
      };
    }),
  );

  return {
    projects: entries.sort((left, right) => {
      if (left.isCurrent !== right.isCurrent) {
        return left.isCurrent ? -1 : 1;
      }
      if (left.queued !== right.queued) {
        return left.queued ? -1 : 1;
      }
      return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    }),
  };
}

async function resolveEmployeeContext(workspacePath) {
  const normalizedWorkspace = String(workspacePath || "").replace(/[\\/]+$/, "");
  if (!normalizedWorkspace) {
    throw new Error("workspacePath is required");
  }

  const employeeRoot = deriveEmployeeRootFromWorkspace(normalizedWorkspace);
  const files = employeeRootFiles(employeeRoot);
  const [employeeProfile, currentProjectPointer, dispatchQueue] = await Promise.all([
    readJsonFile(files.employeeProfilePath, {}),
    readJsonFile(files.currentProjectPath, null),
    readJsonFile(files.dispatchQueuePath, { items: [] }),
  ]);

  const currentWorkspace =
    String(currentProjectPointer?.workspacePath || "").replace(/[\\/]+$/, "") || normalizedWorkspace;
  const currentMeta = await readJsonFile(path.join(currentWorkspace, "runtime", "meta.json"), {});
  const currentTaskState = await summarizeCurrentTask(currentWorkspace);
  const memberId = employeeProfile.memberId ?? currentMeta.memberId ?? "";
  const liveSession =
    (memberId && sessions.has(memberId) ? sessions.get(memberId) : null) ??
    Array.from(sessions.values()).find(
      (session) =>
        String(session.cwd).replace(/\\/g, "/").toLowerCase() === currentWorkspace.replace(/\\/g, "/").toLowerCase(),
    ) ??
    null;
  const persistedStatus = currentMeta.status ?? "initialized";
  const runtimeStatus = liveSession
    ? "running"
    : persistedStatus === "running"
      ? "stopped"
      : mapMetaStatus(persistedStatus);
  const recoveryPending = !liveSession && persistedStatus === "running";
  const workStatus =
    currentMeta.workStatus === "busy" ||
    currentMeta.workStatus === "blocked" ||
    currentMeta.workStatus === "idle"
      ? currentMeta.workStatus
      : runtimeStatus === "error"
        ? "blocked"
        : "idle";

  return {
    currentMeta,
    currentProjectName:
      currentProjectPointer?.projectName || deriveProjectNameFromWorkspace(currentWorkspace),
    currentTaskState,
    currentWorkspace: currentWorkspace.replace(/\\/g, "/"),
    dispatchItems: Array.isArray(dispatchQueue?.items) ? dispatchQueue.items : [],
    employeeProfile,
    employeeRoot: employeeRoot.replace(/\\/g, "/"),
    liveSession,
    memberId,
    recoveryPending,
    runtimeStatus,
    workStatus,
  };
}

async function getEmployeeInfo(workspacePath) {
  const context = await resolveEmployeeContext(workspacePath);
  return {
    employee: {
      company: context.employeeProfile.company ?? context.currentMeta.company ?? "",
      currentProject: context.currentProjectName,
      currentWorkspace: context.currentWorkspace,
      department: context.employeeProfile.department ?? context.currentMeta.department ?? "",
      employeeCode: context.employeeProfile.employeeCode ?? context.currentMeta.employeeCode ?? "",
      employeeName: context.employeeProfile.employeeName ?? context.currentMeta.employeeName ?? "",
      employeeRoot: context.employeeRoot,
      memberId: context.memberId,
      permission: context.currentMeta.permission ?? context.employeeProfile.permission ?? "",
      repoSource:
        context.currentMeta.agentRepoSource ?? context.employeeProfile.repoSource ?? "",
      role: context.employeeProfile.role ?? context.currentMeta.role ?? "",
      shell: context.employeeProfile.shell ?? context.currentMeta.shell ?? "",
    },
  };
}

async function getEmployeeStatus(workspacePath) {
  const context = await resolveEmployeeContext(workspacePath);
  return {
    status: {
      currentProject: context.currentProjectName,
      currentTask: context.currentTaskState.currentTask,
      nextAction: context.currentTaskState.nextAction,
      pid: context.liveSession?.pid,
      recoveryPending: context.recoveryPending,
      runtimeStatus: context.runtimeStatus,
      sessionId: context.liveSession?.id ?? "",
      startedAt: context.liveSession?.startedAt ?? context.currentMeta.startedAt ?? "",
      stoppedAt: context.currentMeta.stoppedAt ?? null,
      workStatus: context.workStatus,
      workspacePath: context.currentWorkspace,
    },
  };
}

async function getEmployeeTasks(workspacePath) {
  const context = await resolveEmployeeContext(workspacePath);
  const projects = await listEmployeeProjectSpaces(workspacePath);
  return {
    tasks: {
      currentProject: context.currentProjectName,
      currentTask: context.currentTaskState.currentTask,
      nextAction: context.currentTaskState.nextAction,
      queuedProjects: context.dispatchItems,
      queuedProjectCount: context.dispatchItems.length,
      projects: projects.projects,
    },
  };
}

async function getEmployeeDeliveries(workspacePath) {
  const history = await listWorkspaceHistory(workspacePath);
  return {
    deliveries: {
      artifacts: history.artifacts,
      finished: history.finished,
      totalArtifacts: history.artifacts.length,
      totalFinished: history.finished.length,
    },
  };
}

async function deleteEmployeeWorkspace(payload) {
  const workspacePath = String(payload?.workspacePath || "").replace(/[\\/]+$/, "");
  if (!workspacePath) {
    throw new Error("workspacePath is required");
  }

  const context = await resolveEmployeeContext(workspacePath);
  const employeeRoot = String(context.employeeRoot || "").replace(/[\\/]+$/, "");
  if (!employeeRoot) {
    throw new Error("employeeRoot is required");
  }

  if (context.memberId) {
    terminateSession(context.memberId);
  }

  await rm(employeeRoot, { force: true, recursive: true });

  return {
    deleted: true,
    employeeName:
      context.employeeProfile.employeeName ??
      context.currentMeta.employeeName ??
      path.basename(employeeRoot),
    employeeRoot,
    memberId: context.memberId,
    workspacePath,
  };
}

async function collectProjectResultArchiveItems(projectWorkspace) {
  const normalizedWorkspace = String(projectWorkspace || "").replace(/[\\/]+$/, "");
  if (!normalizedWorkspace) {
    return [];
  }

  const projectName = sanitizeDownloadName(
    deriveProjectNameFromWorkspace(normalizedWorkspace),
    "project",
  );
  const [artifactEntries, finishedContent] = await Promise.all([
    listArtifactEntries(normalizedWorkspace),
    readWorkspaceFileContent(normalizedWorkspace, "finished.md"),
  ]);
  const finishedEntries = listFinishedEntries(normalizedWorkspace, finishedContent);
  const archiveItems = [];

  if (finishedEntries.length > 0) {
    const finishedPath = path.join(normalizedWorkspace, "finished.md");
    if (existsSync(finishedPath)) {
      archiveItems.push({
        archivePath: `${projectName}/finished.md`,
        filePath: finishedPath,
      });
    }
  }

  for (const artifact of artifactEntries) {
    if (!artifact.filePath) {
      continue;
    }

    archiveItems.push({
      archivePath: `${projectName}/artifacts/${artifact.detail}`,
      filePath: artifact.filePath,
    });
  }

  return archiveItems;
}

async function streamResultsArchiveDownload(response, workspacePath, scope = "project") {
  const normalizedWorkspace = String(workspacePath || "").replace(/[\\/]+$/, "");
  if (!normalizedWorkspace) {
    throw new Error("workspacePath is required");
  }

  const normalizedScope = scope === "employee" ? "employee" : "project";
  let archiveItems = [];
  let archiveName = "";

  if (normalizedScope === "employee") {
    const workspaces = await listEmployeeProjectWorkspaces(normalizedWorkspace);
    const dedupedWorkspaces = Array.from(
      new Set((workspaces.length > 0 ? workspaces : [normalizedWorkspace]).map((item) => item.replace(/[\\/]+$/, ""))),
    );

    for (const projectWorkspace of dedupedWorkspaces) {
      archiveItems.push(...(await collectProjectResultArchiveItems(projectWorkspace)));
    }

    archiveName = `${sanitizeDownloadName(
      deriveEmployeeNameFromWorkspace(normalizedWorkspace),
      "employee",
    )}-results.zip`;
  } else {
    archiveItems = await collectProjectResultArchiveItems(normalizedWorkspace);
    archiveName = `${sanitizeDownloadName(
      deriveProjectNameFromWorkspace(normalizedWorkspace),
      "project",
    )}-results.zip`;
  }

  const uniqueItems = Array.from(
    new Map(
      archiveItems.map((item) => [
        `${item.archivePath.toLowerCase()}::${String(item.filePath).replace(/\\/g, "/").toLowerCase()}`,
        item,
      ]),
    ).values(),
  );

  if (uniqueItems.length === 0) {
    throw new Error("当前没有可下载的成果");
  }

  response.writeHead(
    200,
    createCorsHeaders({
      "Cache-Control": "no-store",
      "Content-Disposition": buildContentDisposition(archiveName),
      "Content-Type": "application/zip",
    }),
  );

  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", reject);
    response.on("close", resolve);
    response.on("finish", resolve);
    archive.pipe(response);

    for (const item of uniqueItems) {
      archive.file(item.filePath, {
        name: item.archivePath.replace(/\\/g, "/"),
      });
    }

    archive.finalize().catch(reject);
  });
}

async function switchEmployeeProject(payload) {
  const context = await resolveEmployeeContext(payload.workspacePath);
  const targetWorkspacePath = String(payload.targetWorkspacePath || "").replace(/[\\/]+$/, "");

  if (!targetWorkspacePath) {
    throw new Error("targetWorkspacePath is required");
  }

  const targetProjectName = deriveProjectNameFromWorkspace(targetWorkspacePath);
  if (
    targetWorkspacePath.replace(/\\/g, "/").toLowerCase() ===
    context.currentWorkspace.replace(/\\/g, "/").toLowerCase()
  ) {
    return {
      mode: "unchanged",
      projectName: targetProjectName,
      workspacePath: context.currentWorkspace,
    };
  }

  if (context.currentTaskState.currentTask !== "暂无") {
    return {
      currentProject: context.currentProjectName,
      currentTask: context.currentTaskState.currentTask,
      mode: "blocked_active_task",
      nextAction: context.currentTaskState.nextAction,
      projectName: targetProjectName,
      workspacePath: context.currentWorkspace,
    };
  }

  await updateCurrentProjectPointer(
    deriveEmployeeRootFromWorkspace(context.currentWorkspace),
    targetWorkspacePath,
  );

  return {
    mode: "switched",
    projectName: targetProjectName,
    workspacePath: targetWorkspacePath.replace(/\\/g, "/"),
  };
}

function hasAssignedTaskRequest(content) {
  const lines = extractMeaningfulTextLines(content);
  if (lines.length === 0) {
    return false;
  }

  return !lines.every((line) => /当前暂无待解析需求/.test(line));
}

function parseStartupAckStatus(content) {
  if (!String(content).trim()) {
    return "none";
  }

  const match = String(content).match(/-\s*状态：(.+)/);
  const statusText = match?.[1]?.trim() ?? "";

  if (!statusText) {
    return "acknowledged";
  }
  if (/待确认/.test(statusText)) {
    return "pending_ack";
  }
  if (/确认中/.test(statusText)) {
    return "confirming";
  }
  if (/确认失败/.test(statusText)) {
    return "confirm_failed";
  }
  if (/无待确认任务/.test(statusText)) {
    return "none";
  }
  if (/已出计划|已生成计划/.test(statusText)) {
    return "planned";
  }
  if (/已确认/.test(statusText)) {
    return "acknowledged";
  }

  return "acknowledged";
}

function updateStartupAckContent(content, statusText, errorMessage = "") {
  let next = String(content || "").trimEnd();

  if (!next) {
    next = "# 首轮确认";
  }

  if (/- 状态：.+/m.test(next)) {
    next = next.replace(/- 状态：.+/m, `- 状态：${statusText}`);
  } else {
    next = `${next}\n\n- 状态：${statusText}`;
  }

  if (/- 错误：.+/m.test(next)) {
    next = next.replace(/- 错误：.+/m, errorMessage ? `- 错误：${errorMessage}` : "");
  }

  if (errorMessage && !/- 错误：.+/m.test(next)) {
    next = `${next}\n- 错误：${errorMessage}`;
  }

  return `${next.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function getTaskField(lines, fieldName) {
  const line = lines.find((value) => value.startsWith(`- ${fieldName}：`));
  return line ? line.replace(`- ${fieldName}：`, "").trim() : "";
}

function parseTaskMetadataFromContent(content) {
  const lines = extractMeaningfulTextLines(content);
  const currentTaskLine = lines.find((line) => /^- (当前执行项|待解析新任务|下一个任务|任务摘要|任务)：/.test(line));
  const firstMeaningful = lines.find(
    (line) =>
      !/^-\s*(优先级|时间窗口|截止时间|指派来源|指派时间|当前状态|状态|来源|下一步|下一步动作|当前步骤|更新时间)：/.test(line),
  );

  return {
    assignedAt: getTaskField(lines, "指派时间"),
    deadlineAt: getTaskField(lines, "截止时间"),
    nextAction: getTaskField(lines, "下一步") || getTaskField(lines, "下一步动作"),
    priority: getTaskField(lines, "优先级"),
    source: getTaskField(lines, "指派来源"),
    status: getTaskField(lines, "当前状态") || getTaskField(lines, "状态"),
    summary: currentTaskLine
      ? currentTaskLine.replace(/^- (当前执行项|待解析新任务|下一个任务|任务摘要|任务)：/, "").trim()
      : firstMeaningful?.replace(/^- /, "").trim() ?? "",
    timeWindow: getTaskField(lines, "时间窗口"),
  };
}

function parseMarkdownSections(content) {
  const normalized = String(content)
    .replace(/`r`n/g, "\n")
    .replace(/`n/g, "\n")
    .replace(/`r/g, "\n");
  const lines = normalized.split(/\r?\n/);
  const sections = [];
  let currentTitle = "";
  let currentBody = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (currentTitle) {
        sections.push({
          body: currentBody.join("\n").trim(),
          title: currentTitle,
        });
      }
      currentTitle = line.slice(3).trim();
      currentBody = [];
      continue;
    }

    if (currentTitle) {
      currentBody.push(line);
    }
  }

  if (currentTitle) {
    sections.push({
      body: currentBody.join("\n").trim(),
      title: currentTitle,
    });
  }

  return sections;
}

function buildWaitFinishedContent(sections) {
  if (sections.length === 0) {
    return "# 待完成任务\n\n- 暂无待办\n";
  }

  return `# 待完成任务\n\n${sections
    .map((section) => `## ${section.title}\n\n${section.body.trim()}\n`)
    .join("\n")}`.trimEnd() + "\n";
}

function parseWaitFinishedQueue(content) {
  const sections = parseMarkdownSections(content);
  if (sections.length === 0) {
    return [];
  }

  return sections
    .map((section) => {
      const task = parseTaskMetadataFromContent(section.body);
      const fallbackTitle = String(section.title || "")
        .replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s+/, "")
        .trim();
      return (task.summary || fallbackTitle).replace(/^- /, "").trim();
    })
    .filter((summary) => summary && !/暂无待办/.test(summary));
}

function buildPendingCurrentTaskMarkdown(task, assignedAt) {
  return `# 当前任务\n\n- 待解析新任务：${task.summary}\n- 优先级：${task.priority || "P1"}\n- 时间窗口：${task.timeWindow || "3 小时内"}\n- 截止时间：${task.deadlineAt || "未设置"}\n- 指派来源：${task.source || "手动发布"}\n- 指派时间：${assignedAt || new Date().toISOString()}\n- 下一步：先阅读 task_request.md 并生成 plan.md\n- 来源：任务发布\n`;
}

function buildNoTaskCurrentMarkdown() {
  return "# 当前任务\n\n- 当前暂无任务\n";
}

function sanitizeReferenceFileName(fileName, fallbackPrefix = "reference") {
  const parsed = path.parse(String(fileName || ""));
  const safeName = sanitizePathSegment(parsed.name || fallbackPrefix);
  const safeExt = String(parsed.ext || "").replace(/[^.\w-]/g, "");
  return `${safeName}${safeExt || ""}`;
}

function formatAttachmentSizeLabel(size) {
  const normalized = Number(size || 0);
  if (normalized >= 1024 * 1024) {
    return `${(normalized / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (normalized >= 1024) {
    return `${Math.max(1, Math.round(normalized / 1024))} KB`;
  }
  return `${normalized} B`;
}

async function persistTaskReferenceAttachments(workspacePath, attachments, assignedAt) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const referencesDir = path.join(workspacePath, "references");
  await mkdir(referencesDir, { recursive: true });
  const timestampPrefix = assignedAt.replace(/[:.]/g, "-");
  const savedReferences = [];

  for (const [index, attachment] of attachments.entries()) {
    const contentBase64 = String(attachment?.contentBase64 || "").trim();
    if (!contentBase64) {
      continue;
    }

    const sanitizedName = sanitizeReferenceFileName(
      attachment?.name,
      `reference-${index + 1}`,
    );
    const storedName = `${timestampPrefix}-${String(index + 1).padStart(2, "0")}-${sanitizedName}`;
    const absolutePath = path.join(referencesDir, storedName);
    const fileBuffer = Buffer.from(contentBase64, "base64");
    await writeFile(absolutePath, fileBuffer);

    savedReferences.push({
      absolutePath: absolutePath.replace(/\\/g, "/"),
      isImage: Boolean(attachment?.isImage) || String(attachment?.mimeType || "").startsWith("image/"),
      mimeType: String(attachment?.mimeType || "application/octet-stream"),
      name: String(attachment?.name || storedName),
      relativePath: `references/${storedName}`.replace(/\\/g, "/"),
      size: Number(attachment?.size || fileBuffer.length || 0),
      storedName,
    });
  }

  return savedReferences;
}

function buildReferenceListMarkdown(savedReferences) {
  if (!Array.isArray(savedReferences) || savedReferences.length === 0) {
    return "";
  }

  return [
    "### 参考资料",
    "",
    ...savedReferences.map((reference) => {
      const imageLabel = reference.isImage ? " · 图片参考" : "";
      return `- \`${reference.relativePath}\` · ${reference.mimeType} · ${formatAttachmentSizeLabel(reference.size)}${imageLabel}`;
    }),
    "",
    "在生成计划之前，请先阅读或查看这些参考资料。",
  ].join("\n");
}

function buildNoPendingStartupAckMarkdown() {
  return "# 首轮确认\n\n- 状态：无待确认任务\n";
}

function parseCurrentTaskState(content) {
  const lines = extractMeaningfulTextLines(content);
  if (lines.length === 0) {
    return {
      currentTask: "暂无",
      nextAction: "暂无",
    };
  }

  const currentTaskLine = lines.find((line) => /^- (当前执行项|待解析新任务|任务|最近完成)：/.test(line));
  const nextActionLine = lines.find((line) => /^- (下一步|下一步动作)：/.test(line));
  const statusLine = lines.find((line) => /^- (当前状态|状态)：/.test(line));
  const isCompleted = Boolean(
    statusLine && /已完成|暂无执行中任务|当前暂无任务/.test(statusLine),
  );
  const firstMeaningful = lines.find(
    (line) =>
      !/^-\s*(优先级|时间窗口|截止时间|指派来源|指派时间|当前状态|状态|来源|当前步骤|更新时间|最近完成|完成时间|结果)：/.test(line),
  );

  const rawTask = currentTaskLine
    ? currentTaskLine.replace(/^- (当前执行项|待解析新任务|下一个任务|任务摘要|任务|最近完成)：/, "").trim()
    : firstMeaningful?.replace(/^- /, "").trim() ?? "";
  const rawNextAction = nextActionLine
    ? nextActionLine.replace(/^- (下一步|下一步动作)：/, "").trim()
    : "";

  const currentTask =
    !rawTask ||
    isCompleted ||
    /当前暂无任务|已完成|最近完成/.test(rawTask)
      ? "暂无"
      : rawTask;
  const nextAction =
    !rawNextAction ||
    isCompleted ||
    /等待下一条任务指派|等待下一项任务|等待新的任务指派|暂无/.test(rawNextAction)
      ? "暂无"
      : rawNextAction;

  return {
    currentTask,
    nextAction,
  };
}

async function buildRestoreSummaryMarkdown(workspacePath) {
  const [taskRequestContent, startupAckContent, currentContent, planContent, blockContent, metaContent] = await Promise.all([
    readWorkspaceFileContent(workspacePath, "task_request.md"),
    readWorkspaceFileContent(workspacePath, "startup_ack.md"),
    readWorkspaceFileContent(workspacePath, "current.md"),
    readWorkspaceFileContent(workspacePath, "plan.md"),
    readWorkspaceFileContent(workspacePath, "block.md"),
    readWorkspaceFileContent(workspacePath, path.join("runtime", "meta.json")),
  ]);

  return `# 恢复摘要

- 生成时间：${new Date().toISOString()}
- 工作空间：${String(workspacePath).replace(/\\/g, "/")}

## 恢复说明

- 本文件由客户端在启动 / 重启员工会话前自动刷新
- Codex 启动后应先阅读本文件，再结合 current.md / plan.md / block.md 继续工作

## task_request.md 摘要

${truncatePromptContent(taskRequestContent || "当前没有新发布的原始任务", 2500)}

## startup_ack.md 摘要

${truncatePromptContent(startupAckContent || "当前尚未完成首轮确认", 2500)}

## current.md 摘要

${truncatePromptContent(currentContent || "当前暂无任务", 2000)}

## plan.md 摘要

${truncatePromptContent(planContent || "尚未制定计划", 2500)}

## block.md 摘要

${truncatePromptContent(blockContent || "暂无阻塞", 2000)}

## runtime/meta.json 摘要

${truncatePromptContent(metaContent || "暂无运行时元数据", 2000)}
`;
}

function describeTaskTimeWindow(timeWindow) {
  switch (String(timeWindow || "").trim()) {
    case "within_30m":
      return { deadlineAt: 30 * 60 * 1000, label: "30 分钟内" };
    case "within_1h":
      return { deadlineAt: 60 * 60 * 1000, label: "1 小时内" };
    case "within_3h":
      return { deadlineAt: 3 * 60 * 60 * 1000, label: "3 小时内" };
    case "within_12h":
      return { deadlineAt: 12 * 60 * 60 * 1000, label: "12 小时内" };
    case "within_24h":
      return { deadlineAt: 24 * 60 * 60 * 1000, label: "24 小时内" };
    case "no_deadline":
      return { deadlineAt: null, label: "无明确截止" };
    default:
      return { deadlineAt: 3 * 60 * 60 * 1000, label: "3 小时内" };
  }
}

async function assignTaskWithinWorkspace(payload) {
  const workspacePath = String(payload.workspacePath || "").replace(/[\\/]+$/, "");
  const taskDescription = String(payload.taskDescription || "").trim();

  if (!workspacePath) {
    throw new Error("workspacePath is required");
  }
  if (!taskDescription) {
    throw new Error("taskDescription is required");
  }

  const assignedAt = new Date().toISOString();
  const priority = String(payload.priority || "P1").trim() || "P1";
  const source = String(payload.source || "manual").trim() || "manual";
  const timeWindowKey = String(payload.timeWindow || "within_3h").trim() || "within_3h";
  const timeWindowMeta = describeTaskTimeWindow(timeWindowKey);
  const deadlineAt =
    typeof timeWindowMeta.deadlineAt === "number"
      ? new Date(Date.parse(assignedAt) + timeWindowMeta.deadlineAt).toISOString()
      : "";
  const timeWindow = timeWindowMeta.label;
  const savedReferences = await persistTaskReferenceAttachments(
    workspacePath,
    payload.attachments,
    assignedAt,
  );
  const referenceSection = buildReferenceListMarkdown(savedReferences);
  const taskSummary =
    taskDescription
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? taskDescription;

  const currentPath = path.join(workspacePath, "current.md");
  const taskRequestPath = path.join(workspacePath, "task_request.md");
  const startupAckPath = path.join(workspacePath, "startup_ack.md");
  const planPath = path.join(workspacePath, "plan.md");
  const waitFinishedPath = path.join(workspacePath, "wait_finished.md");
  const restoreSummaryPath = path.join(workspacePath, "restore_summary.md");
  const runtimeMetaPath = path.join(workspacePath, "runtime", "meta.json");

  const currentContent = await readOptionalTextFile(currentPath);
  const assignMode =
    payload.forceCurrent || canActivateTaskImmediately(currentContent) ? "current" : "queued";

  await appendMarkdownSection(
    taskRequestPath,
    `${assignedAt} 原始任务`,
    `- 任务摘要：${taskSummary}\n- 优先级：${priority}\n- 时间窗口：${timeWindow}\n- 截止时间：${deadlineAt || "未设置"}\n- 指派来源：${source}\n- 来源：任务发布${savedReferences.length > 0 ? `\n- 参考资料数：${savedReferences.length}` : ""}\n\n### 原始需求\n\n${taskDescription}${referenceSection ? `\n\n${referenceSection}` : ""}`,
  );

  await writeFile(
    startupAckPath,
    `# 首轮确认\n\n- 状态：待确认\n- 最近任务摘要：${taskSummary}\n- 优先级：${priority}\n- 时间窗口：${timeWindow}\n- 截止时间：${deadlineAt || "未设置"}\n- 指派来源：${source}\n- 指派时间：${assignedAt}${savedReferences.length > 0 ? `\n- 参考资料数：${savedReferences.length}` : ""}\n\n## 要求\n\n1. 先阅读 task_request.md${savedReferences.length > 0 ? " 和 references/ 下的参考资料" : ""}\n2. 生成或更新 plan.md\n3. 在本文件回写你的理解摘要、计划状态与下一步动作\n`,
    "utf8",
  );

  await ensureTextFile(
    planPath,
    "# 规划文件\n\n- 暂无规划\n",
  );

  if (assignMode === "current") {
    await writeFile(
      currentPath,
      `# 当前任务\n\n- 待解析新任务：${taskSummary}\n- 优先级：${priority}\n- 时间窗口：${timeWindow}\n- 截止时间：${deadlineAt || "未设置"}\n- 指派来源：${source}\n- 指派时间：${assignedAt}\n- 下一步：先阅读 task_request.md${savedReferences.length > 0 ? " 和 references/ 参考资料" : ""}并生成 plan.md\n- 来源：任务发布\n`,
      "utf8",
    );
  } else {
    await appendMarkdownSection(
      waitFinishedPath,
      `${assignedAt} 待解析任务`,
      `- ${taskSummary}\n- 优先级：${priority}\n- 时间窗口：${timeWindow}\n- 截止时间：${deadlineAt || "未设置"}\n- 指派来源：${source}\n- 来源：任务发布${savedReferences.length > 0 ? `\n- 参考资料数：${savedReferences.length}` : ""}\n- 后续动作：处理完当前任务后读取 task_request.md${savedReferences.length > 0 ? " 和 references/ 参考资料" : ""}并生成计划`,
    );
  }

  await mergeJsonFile(runtimeMetaPath, {
    lastAction: "assign_task",
    lastAssignedAt: assignedAt,
    lastAssignedDeadline: deadlineAt || null,
    lastAssignedReferences: savedReferences.map((reference) => ({
      absolutePath: reference.absolutePath,
      isImage: reference.isImage,
      mimeType: reference.mimeType,
      name: reference.name,
      relativePath: reference.relativePath,
      size: reference.size,
    })),
    lastAssignedPriority: priority,
    lastAssignedSource: source,
    lastAssignedTimeWindow: timeWindow,
    lastAssignedTask: taskSummary,
  });

  const restoreSummaryContent = await buildRestoreSummaryMarkdown(workspacePath);
  await writeFile(restoreSummaryPath, `${restoreSummaryContent}\n`, "utf8");

  return {
    assigned: true,
    assignedAt,
    currentTask: taskSummary,
    deadlineAt,
    attachments: savedReferences.map((reference) => ({
      isImage: reference.isImage,
      mimeType: reference.mimeType,
      name: reference.name,
      relativePath: reference.relativePath,
      size: reference.size,
    })),
    mode: assignMode,
    priority,
    source,
    taskDescription,
    timeWindow,
    workspacePath: workspacePath.replace(/\\/g, "/"),
  };
}

async function assignTaskToWorkspace(payload) {
  const currentWorkspacePath = String(payload.workspacePath || "").replace(/[\\/]+$/, "");
  if (!currentWorkspacePath) {
    throw new Error("workspacePath is required");
  }

  const requestedProjectName = sanitizePathSegment(
    String(payload.projectName || deriveProjectNameFromWorkspace(currentWorkspacePath)).trim() ||
      deriveProjectNameFromWorkspace(currentWorkspacePath),
  );
  const currentProjectName = deriveProjectNameFromWorkspace(currentWorkspacePath);
  const sameProject = requestedProjectName === currentProjectName;
  const employeeRoot = deriveEmployeeRootFromWorkspace(currentWorkspacePath);
  const currentContent = await readOptionalTextFile(path.join(currentWorkspacePath, "current.md"));
  const canSwitchNow = canActivateTaskImmediately(currentContent);
  const targetWorkspacePath = sameProject
    ? currentWorkspacePath
    : await ensureProjectWorkspaceForAssignment(currentWorkspacePath, requestedProjectName);

  const assignResult = await assignTaskWithinWorkspace({
    ...payload,
    forceCurrent: sameProject ? payload.forceCurrent : true,
    workspacePath: targetWorkspacePath,
  });

  if (sameProject) {
    await updateCurrentProjectPointer(employeeRoot, currentWorkspacePath);
    return {
      ...assignResult,
      projectName: requestedProjectName,
      sameProject: true,
      switchWorkspacePath: null,
    };
  }

  if (canSwitchNow) {
    await updateCurrentProjectPointer(employeeRoot, targetWorkspacePath);
  } else {
    await updateCurrentProjectPointer(employeeRoot, currentWorkspacePath);
    await enqueueEmployeeProjectDispatch(employeeRoot, {
      createdAt: assignResult.assignedAt,
      deadlineAt: assignResult.deadlineAt,
      priority: assignResult.priority,
      projectName: requestedProjectName,
      source: assignResult.source,
      status: "queued_switch",
      taskSummary: assignResult.currentTask,
      timeWindow: assignResult.timeWindow,
      workspacePath: targetWorkspacePath,
    });
  }

  return {
    ...assignResult,
    mode: canSwitchNow ? "project_switch" : "queued_project",
    projectName: requestedProjectName,
    sameProject: false,
    switchWorkspacePath: canSwitchNow ? targetWorkspacePath.replace(/\\/g, "/") : null,
  };
}

async function retryStartupAck(payload) {
  const workspacePath = String(payload.workspacePath || "").replace(/[\\/]+$/, "");
  if (!workspacePath) {
    throw new Error("workspacePath is required");
  }

  void runStartupAckPreflight({
    cwd: workspacePath,
    permission: payload.permission,
    shell: payload.shell,
  }).catch(() => false);

  return {
    retried: true,
    workspacePath: workspacePath.replace(/\\/g, "/"),
  };
}

async function completeCurrentTask(payload) {
  const workspacePath = String(payload.workspacePath || "").replace(/[\\/]+$/, "");
  if (!workspacePath) {
    throw new Error("workspacePath is required");
  }

  const employeeRoot = deriveEmployeeRootFromWorkspace(workspacePath);
  const currentProjectName = deriveProjectNameFromWorkspace(workspacePath);
  const currentPath = path.join(workspacePath, "current.md");
  const finishedPath = path.join(workspacePath, "finished.md");
  const waitFinishedPath = path.join(workspacePath, "wait_finished.md");
  const startupAckPath = path.join(workspacePath, "startup_ack.md");
  const restoreSummaryPath = path.join(workspacePath, "restore_summary.md");
  const runtimeMetaPath = path.join(workspacePath, "runtime", "meta.json");
  const artifactsDir = path.join(workspacePath, "artifacts");

  const currentContent = await readOptionalTextFile(currentPath);
  const currentTask = parseTaskMetadataFromContent(currentContent);

  if (!currentTask.summary || currentTask.summary === "暂无") {
    throw new Error("当前没有可完成的任务");
  }

  const completedAt = new Date().toISOString();
  const artifactFileName = `completion_${completedAt.replace(/[:.]/g, "-")}.md`;
  const artifactPath = path.join(artifactsDir, artifactFileName);

  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    artifactPath,
    `# 任务完成摘要\n\n- 任务：${currentTask.summary}\n- 完成时间：${completedAt}\n- 优先级：${currentTask.priority || "P1"}\n- 时间窗口：${currentTask.timeWindow || "3 小时内"}\n- 截止时间：${currentTask.deadlineAt || "未设置"}\n- 指派来源：${currentTask.source || "手动发布"}\n\n## 完成说明\n\n- 由客户端执行归档动作生成\n- 详情可结合 finished.md 与相关交付物继续补充\n`,
    "utf8",
  );

  await appendMarkdownSection(
    finishedPath,
    `${completedAt} 完成任务`,
    `- ${currentTask.summary}\n- 优先级：${currentTask.priority || "P1"}\n- 时间窗口：${currentTask.timeWindow || "3 小时内"}\n- 截止时间：${currentTask.deadlineAt || "未设置"}\n- 指派来源：${currentTask.source || "手动发布"}\n- 归档：artifacts/${artifactFileName}`,
  );
  await appendDeliveryIndex(employeeRoot, {
    completedAt,
    filePath: artifactPath,
    projectName: currentProjectName,
    title: currentTask.summary,
    workspacePath,
  });

  const waitFinishedContent = await readOptionalTextFile(waitFinishedPath);
  const sections = parseMarkdownSections(waitFinishedContent);
  const nextSection = sections.shift() ?? null;

  await writeFile(waitFinishedPath, buildWaitFinishedContent(sections), "utf8");

  let switchWorkspacePath = null;
  let switchProjectName = null;

  if (nextSection) {
    const nextTask = parseTaskMetadataFromContent(nextSection.body);
    await writeFile(
      currentPath,
      buildPendingCurrentTaskMarkdown(
        {
          ...nextTask,
          summary: nextTask.summary || nextSection.title,
        },
        nextTask.assignedAt,
      ),
      "utf8",
    );
    await writeFile(
      startupAckPath,
      `# 首轮确认\n\n- 状态：待确认\n- 最近任务摘要：${nextTask.summary || nextSection.title}\n- 优先级：${nextTask.priority || "P1"}\n- 时间窗口：${nextTask.timeWindow || "3 小时内"}\n- 截止时间：${nextTask.deadlineAt || "未设置"}\n- 指派来源：${nextTask.source || "手动发布"}\n- 指派时间：${nextTask.assignedAt || new Date().toISOString()}\n\n## 要求\n\n1. 先阅读 task_request.md\n2. 生成或更新 plan.md\n3. 在本文件回写你的理解摘要、计划状态与下一步动作\n`,
      "utf8",
    );
    await mergeJsonFile(runtimeMetaPath, {
      lastAction: "complete_task",
      lastAssignedAt: nextTask.assignedAt || null,
      lastAssignedDeadline: nextTask.deadlineAt || null,
      lastAssignedPriority: nextTask.priority || null,
      lastAssignedSource: nextTask.source || null,
      lastAssignedTimeWindow: nextTask.timeWindow || null,
      lastAssignedTask: nextTask.summary || nextSection.title,
      lastCompletedAt: completedAt,
      lastCompletedTask: currentTask.summary,
      workStatus: "busy",
    });
  } else {
    await writeFile(currentPath, buildNoTaskCurrentMarkdown(), "utf8");
    await writeFile(startupAckPath, buildNoPendingStartupAckMarkdown(), "utf8");
    await mergeJsonFile(runtimeMetaPath, {
      lastAction: "complete_task",
      lastAssignedAt: null,
      lastAssignedDeadline: null,
      lastAssignedPriority: null,
      lastAssignedSource: null,
      lastAssignedTimeWindow: null,
      lastAssignedTask: null,
      lastCompletedAt: completedAt,
      lastCompletedTask: currentTask.summary,
      workStatus: "idle",
    });

    const nextProjectDispatch = await popNextEmployeeProjectDispatch(employeeRoot);
    if (nextProjectDispatch?.workspacePath) {
      switchWorkspacePath = String(nextProjectDispatch.workspacePath).replace(/\\/g, "/");
      switchProjectName = nextProjectDispatch.projectName ?? deriveProjectNameFromWorkspace(switchWorkspacePath);
      await updateCurrentProjectPointer(employeeRoot, switchWorkspacePath);
    }
  }

  const restoreSummaryContent = await buildRestoreSummaryMarkdown(workspacePath);
  await writeFile(restoreSummaryPath, `${restoreSummaryContent}\n`, "utf8");

  return {
    artifactFileName,
    completed: true,
    completedAt,
    completedTask: currentTask.summary,
    hasNextTask: Boolean(nextSection),
    nextTask: nextSection ? parseTaskMetadataFromContent(nextSection.body).summary || nextSection.title : null,
    switchProjectName,
    switchWorkspacePath,
    workspacePath: workspacePath.replace(/\\/g, "/"),
  };
}

async function openLocalPath(targetPath) {
  const normalizedPath = path.normalize(String(targetPath));
  const targetStat = await stat(normalizedPath).catch(() => null);

  if (!targetStat) {
    throw new Error(`path not found: ${normalizedPath}`);
  }

  if (process.platform === "win32") {
    await execFileAsync("cmd.exe", ["/c", "start", "", normalizedPath], {
      windowsHide: true,
    });
    return normalizedPath;
  }

  if (process.platform === "darwin") {
    await execFileAsync("open", [normalizedPath], { windowsHide: true });
    return normalizedPath;
  }

  await execFileAsync("xdg-open", [normalizedPath], { windowsHide: true });
  return normalizedPath;
}

async function mergeJsonFile(filePath, patch) {
  let current = {};
  try {
    current = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    current = {};
  }
  await writeFile(filePath, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
}

function mapMetaStatus(status) {
  switch (status) {
    case "running":
      return "running";
    case "error":
      return "error";
    case "stopped":
    case "initialized":
      return "stopped";
    default:
      return "stopped";
  }
}

async function summarizeCurrentTask(workspacePath) {
  try {
    const content = await readFile(path.join(workspacePath, "current.md"), "utf8");
    return parseCurrentTaskState(content);
  } catch {
    return {
      currentTask: "暂无",
      nextAction: "暂无",
    };
  }
}

async function readOptionalTextFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function normalizeMarkdownContent(content, fallback) {
  const normalized = String(content || "").trim();
  return `${(normalized || fallback).trim()}\n`;
}

function workspaceInstructionPaths(workspacePath) {
  return {
    agentsPath: path.join(workspacePath, "AGENTS.md"),
    legacyAgentPath: path.join(workspacePath, "agent.md"),
    rolePath: path.join(workspacePath, "ROLE.md"),
  };
}

function projectTemplateFiles(projectRoot) {
  const templatesDir = path.join(projectRoot, "setting", "templates");
  return {
    agentsTemplatePath: path.join(templatesDir, "AGENTS.md"),
    templatesDir,
  };
}

async function ensureWorkspaceAgentsFile(projectRoot, workspacePath) {
  const normalizedProjectRoot = String(projectRoot || "").replace(/[\\/]+$/, "");
  if (!normalizedProjectRoot) {
    throw new Error("projectRoot is required");
  }

  const { agentsTemplatePath, templatesDir } = projectTemplateFiles(normalizedProjectRoot);
  await mkdir(templatesDir, { recursive: true });
  await ensureTextFile(
    agentsTemplatePath,
    normalizeMarkdownContent(buildWorkspaceAgentsTemplateMarkdown(), "# AGENTS.md\n"),
  );

  const templateContent = await readOptionalTextFile(agentsTemplatePath);
  const { agentsPath } = workspaceInstructionPaths(workspacePath);
  await ensureTextFile(
    agentsPath,
    normalizeMarkdownContent(templateContent, buildWorkspaceAgentsTemplateMarkdown()),
  );

  return agentsPath;
}

async function resolveRoleDefinitionText(workspacePath, employeeRoot = deriveEmployeeRootFromWorkspace(workspacePath)) {
  const workspaceFiles = workspaceInstructionPaths(workspacePath);
  const employeeFiles = employeeRootFiles(employeeRoot);

  return (
    (await readOptionalTextFile(workspaceFiles.rolePath)) ||
    (await readOptionalTextFile(workspaceFiles.legacyAgentPath)) ||
    (await readOptionalTextFile(employeeFiles.rolePath)) ||
    (await readOptionalTextFile(employeeFiles.legacyAgentPath))
  );
}

async function ensureWorkspaceRoleFile(workspacePath, roleContent = "") {
  const { rolePath, legacyAgentPath } = workspaceInstructionPaths(workspacePath);
  const resolvedRoleContent =
    String(roleContent || "").trim() || (await readOptionalTextFile(legacyAgentPath));

  await ensureTextFile(
    rolePath,
    normalizeMarkdownContent(resolvedRoleContent, "# ROLE.md\n\n待补充\n"),
  );

  return rolePath;
}

function extractMeaningfulTextLines(content) {
  const normalized = String(content)
    .replace(/`r`n/g, "\n")
    .replace(/`n/g, "\n")
    .replace(/`r/g, "\n");

  return normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function isPlaceholderCurrentTask(content) {
  const lines = extractMeaningfulTextLines(content);
  if (lines.length === 0) {
    return true;
  }

  return lines.every((line) =>
    /当前暂无任务|等待任务分配|待启动/.test(line),
  );
}

function canActivateTaskImmediately(content) {
  return parseCurrentTaskState(content).currentTask === "暂无";
}

async function appendMarkdownSection(filePath, title, body) {
  const current = await readOptionalTextFile(filePath);
  const normalizedCurrent = current.trimEnd();
  const nextContent = `${normalizedCurrent ? `${normalizedCurrent}\n\n` : ""}## ${title}\n\n${body.trim()}\n`;
  await writeFile(filePath, nextContent, "utf8");
}

async function discoverMetaFiles(rootDir, currentDir = rootDir, results = []) {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "setting") {
        continue;
      }
      await discoverMetaFiles(rootDir, absolutePath, results);
      continue;
    }

    if (entry.isFile() && entry.name === "meta.json" && path.basename(path.dirname(absolutePath)) === "runtime") {
      results.push(absolutePath);
    }
  }

  return results;
}

async function listCompanyDirectories(rootDir) {
  const ignoredDirectories = new Set([
    ".git",
    "setting",
    "docs",
    "dist",
    "node_modules",
    "src",
    "bridge",
    "public",
  ]);
  const entries = await readdir(rootDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !ignoredDirectories.has(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function deriveCompanyFromWorkspace(rootDir, workspacePath) {
  const normalizedRoot = String(rootDir).replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedWorkspace = String(workspacePath).replace(/\\/g, "/");

  if (!normalizedWorkspace.startsWith(`${normalizedRoot}/`)) {
    return "";
  }

  const relativePath = normalizedWorkspace.slice(normalizedRoot.length + 1);
  return relativePath.split("/")[0] ?? "";
}

function deriveDepartmentFromWorkspace(rootDir, workspacePath) {
  const normalizedRoot = String(rootDir).replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedWorkspace = String(workspacePath).replace(/\\/g, "/");

  if (!normalizedWorkspace.startsWith(`${normalizedRoot}/`)) {
    return "";
  }

  const relativePath = normalizedWorkspace.slice(normalizedRoot.length + 1);
  return relativePath.split("/")[1] ?? "";
}

async function discoverWorkspaces(projectRoot) {
  const normalizedRoot = String(projectRoot || "").replace(/[\\/]+$/, "");
  if (!normalizedRoot) {
    throw new Error("projectRoot is required");
  }

  const normalizedProjectRoot = normalizedRoot.replace(/\\/g, "/");
  if (!existsSync(normalizedRoot)) {
    return {
      companies: [],
      projectRoot: normalizedProjectRoot,
      projectRootExists: false,
      runtimes: [],
    };
  }

  const companies = await listCompanyDirectories(normalizedRoot);
  const metaFiles = await discoverMetaFiles(normalizedRoot);
  const runtimes = [];

  for (const metaFile of metaFiles) {
    try {
      const meta = JSON.parse(await readFile(metaFile, "utf8"));
      const workspacePath = meta.workspacePath || path.dirname(path.dirname(metaFile));
      const employeeRoot = deriveEmployeeRootFromWorkspace(workspacePath);
      const currentProjectPointer = await readJsonFile(
        employeeRootFiles(employeeRoot).currentProjectPath,
        null,
      );
      if (
        currentProjectPointer?.workspacePath &&
        String(currentProjectPointer.workspacePath).replace(/\\/g, "/").toLowerCase() !==
          String(workspacePath).replace(/\\/g, "/").toLowerCase()
      ) {
        continue;
      }
      const [currentTaskState, finishedContent, latestArtifact, taskRequestContent, startupAckContent, waitFinishedContent, indexedEntries] = await Promise.all([
        summarizeCurrentTask(workspacePath),
        readWorkspaceFileContent(workspacePath, "finished.md"),
        findLatestArtifact(workspacePath),
        readWorkspaceFileContent(workspacePath, "task_request.md"),
        readWorkspaceFileContent(workspacePath, "startup_ack.md"),
        readWorkspaceFileContent(workspacePath, "wait_finished.md"),
        listEmployeeDeliveryEntries(workspacePath),
      ]);
      const finishedEntries = listFinishedEntries(workspacePath, finishedContent);
      const normalizedWorkspace = String(workspacePath).replace(/\\/g, "/").toLowerCase();
      const liveSession =
        (meta.memberId && sessions.has(meta.memberId) ? sessions.get(meta.memberId) : null) ??
        Array.from(sessions.values()).find(
          (session) => String(session.cwd).replace(/\\/g, "/").toLowerCase() === normalizedWorkspace,
        ) ??
        null;
      const persistedStatus = meta.status ?? "initialized";
      const runtimeStatus = liveSession
        ? "running"
        : persistedStatus === "running"
          ? "stopped"
          : mapMetaStatus(persistedStatus);
      const activeSessionId = liveSession?.id ?? "";
      const activePid = liveSession?.pid;
      const recoveryPending = !liveSession && persistedStatus === "running";
      const workStatus =
        meta.workStatus === "busy" || meta.workStatus === "blocked" || meta.workStatus === "idle"
          ? meta.workStatus
          : runtimeStatus === "error"
            ? "blocked"
            : "idle";
      const hasTaskRequest = hasAssignedTaskRequest(taskRequestContent);
      const taskIntakeStatus = hasTaskRequest
        ? parseStartupAckStatus(startupAckContent)
        : "none";
      const taskQueue = parseWaitFinishedQueue(waitFinishedContent);
      const latestIndexedDelivery = indexedEntries[0] ?? null;

      runtimes.push({
        company: meta.company ?? deriveCompanyFromWorkspace(normalizedRoot, workspacePath),
        currentTask: currentTaskState.currentTask,
        department: meta.department ?? deriveDepartmentFromWorkspace(normalizedRoot, workspacePath),
        diagnostics: [],
        employeeCode: meta.employeeCode ?? "",
        employeeName: meta.employeeName ?? "未知员工",
        lastAction: meta.lastAction ?? "",
        memberId: liveSession?.memberId ?? meta.memberId ?? "",
        permission: meta.permission ?? "受限模式",
        pid: activePid,
        projectName: meta.projectName ?? "",
        recoveryPending,
        repoSource: meta.agentRepoSource ?? "",
        resolvedShell: liveSession?.shell ?? meta.resolvedShell ?? meta.shell ?? "",
        recentArtifact: latestIndexedDelivery?.filePath
          ? path.basename(latestIndexedDelivery.filePath)
          : latestArtifact,
        recentCompleted:
          latestIndexedDelivery?.title ??
          finishedEntries[0]?.title ??
          summarizeMarkdownTail(finishedContent, /暂无记录/),
        role: meta.role ?? "实现执行",
        autoTrustWorkspace: meta.autoTrustWorkspace !== false,
        elevationMode: meta.elevationMode ?? "manual",
        taskDeadline: meta.lastAssignedDeadline ?? null,
        taskIntakeStatus,
        taskPriority: meta.lastAssignedPriority ?? null,
        promptAutomation: meta.promptAutomation ?? "safe_auto",
        taskSource: meta.lastAssignedSource ?? null,
        taskTimeWindow: meta.lastAssignedTimeWindow ?? null,
        nextAction: currentTaskState.nextAction,
        runtimeStatus,
        sessionId: activeSessionId,
        shell: meta.shell ?? "",
        startedAt: liveSession?.startedAt ?? meta.startedAt ?? "",
        status: liveSession ? "running" : persistedStatus,
        stoppedAt: meta.stoppedAt ?? null,
        taskQueue,
        workStatus,
        workspacePath,
      });
    } catch {
      // ignore invalid meta files
    }
  }

  return {
    companies,
    projectRoot: normalizedProjectRoot,
    projectRootExists: true,
    runtimes,
  };
}

async function runGit(args, cwd) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
  });
  return stdout.trim();
}

async function runCommand(command, args, cwd = process.cwd()) {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    windowsHide: true,
  });
  return stdout.trim();
}

async function commandExists(command) {
  try {
    if (process.platform === "win32") {
      await execFileAsync("where.exe", [command], { windowsHide: true });
    } else {
      await execFileAsync("which", [command], { windowsHide: true });
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeRepoUrl(repoUrl) {
  return String(repoUrl || "").trim().replace(/\/+$/, "");
}

function buildGitCloneUrl(repoUrl) {
  const normalized = normalizeRepoUrl(repoUrl);
  if (/^https:\/\/github\.com\//i.test(normalized) && !normalized.endsWith(".git")) {
    return `${normalized}.git`;
  }
  return normalized;
}

function parseGitHubRepository(repoUrl) {
  const normalized = normalizeRepoUrl(repoUrl);
  const match = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) {
    return null;
  }

  const owner = match[1];
  const repo = match[2];
  return {
    owner,
    repo,
    repoUrl: `https://github.com/${owner}/${repo}`,
  };
}

function repoCacheDir(repoUrl, cacheRoot = AGENT_REPO_CACHE_ROOT) {
  const hash = createHash("sha1").update(buildGitCloneUrl(repoUrl)).digest("hex").slice(0, 10);
  return path.join(cacheRoot, hash);
}

function repoCheckoutMetaPath(checkoutDir) {
  return path.join(checkoutDir, ".cclient-agent-repo.json");
}

async function readRepoCheckoutMetadata(checkoutDir) {
  const payload = await readJsonFile(repoCheckoutMetaPath(checkoutDir), null);
  if (!payload || typeof payload !== "object") {
    return null;
  }

  return {
    commit: typeof payload.commit === "string" ? payload.commit : "",
    downloadedAt: typeof payload.downloadedAt === "string" ? payload.downloadedAt : "",
    provider: typeof payload.provider === "string" ? payload.provider : "",
    repoUrl: typeof payload.repoUrl === "string" ? payload.repoUrl : "",
  };
}

async function writeRepoCheckoutMetadata(checkoutDir, payload) {
  await writeFile(
    repoCheckoutMetaPath(checkoutDir),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

async function resolveRepoCheckoutCommit(checkoutDir) {
  const metadata = await readRepoCheckoutMetadata(checkoutDir);
  if (metadata?.commit) {
    return metadata.commit;
  }

  if (existsSync(path.join(checkoutDir, ".git"))) {
    return runGit(["rev-parse", "HEAD"], checkoutDir).catch(() => "local-cache");
  }

  return "local-cache";
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "C-CLIENT",
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`请求失败：${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function downloadFile(url, filePath, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": "C-CLIENT",
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`下载失败：${response.status} ${response.statusText}`);
  }

  const fileBuffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, fileBuffer);
}

async function fetchGitHubArchiveInfo(repoUrl) {
  const githubRepo = parseGitHubRepository(repoUrl);
  if (!githubRepo) {
    return null;
  }

  const repoInfo = await fetchJson(
    `https://api.github.com/repos/${githubRepo.owner}/${githubRepo.repo}`,
  );
  const defaultBranch = String(repoInfo.default_branch || "main");
  const commitInfo = await fetchJson(
    `https://api.github.com/repos/${githubRepo.owner}/${githubRepo.repo}/commits/${encodeURIComponent(defaultBranch)}`,
  );
  const commit = String(commitInfo.sha || "").trim() || defaultBranch;

  return {
    commit,
    provider: "github-archive",
    repoUrl: githubRepo.repoUrl,
    tarballUrl: `https://api.github.com/repos/${githubRepo.owner}/${githubRepo.repo}/tarball/${encodeURIComponent(commit)}`,
  };
}

async function extractTarArchive(archivePath, targetDir) {
  if (!(await commandExists("tar"))) {
    throw new Error("当前环境缺少 tar，无法解压 Agent 仓库归档");
  }

  await runCommand(
    "tar",
    ["-xzf", archivePath, "-C", targetDir, "--strip-components", "1"],
    process.cwd(),
  );
}

async function downloadGitHubRepoCheckout(repoUrl, checkoutDir) {
  const archiveInfo = await fetchGitHubArchiveInfo(repoUrl);
  if (!archiveInfo) {
    return null;
  }

  const parentDir = path.dirname(checkoutDir);
  const tempDir = `${checkoutDir}.tmp`;
  const archivePath = path.join(
    parentDir,
    `${path.basename(checkoutDir)}-${archiveInfo.commit.slice(0, 12) || "archive"}.tar.gz`,
  );
  let moved = false;

  await mkdir(parentDir, { recursive: true });
  await rm(tempDir, { force: true, recursive: true }).catch(() => {});
  await rm(archivePath, { force: true }).catch(() => {});
  await mkdir(tempDir, { recursive: true });

  try {
    await downloadFile(archiveInfo.tarballUrl, archivePath);
    await extractTarArchive(archivePath, tempDir);
    await writeRepoCheckoutMetadata(tempDir, {
      commit: archiveInfo.commit,
      downloadedAt: new Date().toISOString(),
      provider: archiveInfo.provider,
      repoUrl: archiveInfo.repoUrl,
    });
    await rm(checkoutDir, { force: true, recursive: true }).catch(() => {});
    await rename(tempDir, checkoutDir);
    moved = true;
    return archiveInfo;
  } finally {
    await rm(archivePath, { force: true }).catch(() => {});
    if (!moved) {
      await rm(tempDir, { force: true, recursive: true }).catch(() => {});
    }
  }
}

async function ensureRepoCheckout(repoUrl, refresh = false, cacheRoot = AGENT_REPO_CACHE_ROOT) {
  const normalizedRepoUrl = normalizeRepoUrl(repoUrl);
  const cloneRepoUrl = buildGitCloneUrl(normalizedRepoUrl);
  const checkoutDir = repoCacheDir(normalizedRepoUrl, cacheRoot);
  const githubRepo = parseGitHubRepository(normalizedRepoUrl);

  await mkdir(cacheRoot, { recursive: true });

  try {
    if (!existsSync(checkoutDir)) {
      if (githubRepo) {
        await downloadGitHubRepoCheckout(normalizedRepoUrl, checkoutDir);
      } else {
        await runGit(
          ["-c", "http.version=HTTP/1.1", "clone", "--depth", "1", cloneRepoUrl, checkoutDir],
          process.cwd(),
        );
      }
    } else if (refresh) {
      if (githubRepo) {
        await downloadGitHubRepoCheckout(normalizedRepoUrl, checkoutDir);
      } else {
        await runGit(["-c", "http.version=HTTP/1.1", "fetch", "--depth", "1", "origin"], checkoutDir);
        await runGit(["reset", "--hard", "FETCH_HEAD"], checkoutDir);
        await runGit(["clean", "-fd"], checkoutDir);
      }
    }
  } catch (error) {
    const fallbackDir =
      existsSync(checkoutDir) ? checkoutDir : existsSync(DEFAULT_AGENT_REPO_FALLBACK) ? DEFAULT_AGENT_REPO_FALLBACK : null;

    if (!fallbackDir) {
      throw error;
    }

    const fallbackCommit = await resolveRepoCheckoutCommit(fallbackDir).catch(() => "local-fallback");
    return {
      checkoutDir: fallbackDir,
      commit: fallbackCommit,
      repoUrl: githubRepo?.repoUrl ?? normalizedRepoUrl,
      warning:
        error instanceof Error
          ? `仓库同步失败，已使用本地缓存：${error.message}`
          : "仓库同步失败，已使用本地缓存",
    };
  }

  if (!existsSync(checkoutDir)) {
    throw new Error("Agent 仓库缓存目录不存在");
  }

  if (!githubRepo && existsSync(path.join(checkoutDir, ".git"))) {
    const commit = await runGit(["rev-parse", "HEAD"], checkoutDir);
    return {
      checkoutDir,
      commit,
      repoUrl: normalizedRepoUrl,
      warning: "",
    };
  }

  const commit = await resolveRepoCheckoutCommit(checkoutDir);
  return {
    checkoutDir,
    commit,
    repoUrl: githubRepo?.repoUrl ?? normalizedRepoUrl,
    warning: "",
  };
}

function parseFrontMatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return null;
  }

  const frontMatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^"|"$/g, "");
    frontMatter[key] = value;
  }
  return frontMatter;
}

function categoryFromRelativePath(relativePath) {
  const directory = path.dirname(relativePath).replace(/\\/g, "/");
  if (!directory || directory === ".") {
    return "general";
  }
  return directory;
}

async function collectMarkdownFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".github" || entry.name === "scripts") {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(rootDir, absolutePath)));
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    files.push(absolutePath);
  }

  return files;
}

async function parseAgentDefinitions(repoUrl, refresh = false, cacheRoot = AGENT_REPO_CACHE_ROOT) {
  const { checkoutDir, commit, warning } = await ensureRepoCheckout(repoUrl, refresh, cacheRoot);
  const markdownFiles = await collectMarkdownFiles(checkoutDir);
  const agents = [];

  for (const absolutePath of markdownFiles) {
    const relativePath = path.relative(checkoutDir, absolutePath).replace(/\\/g, "/");
    const content = await readFile(absolutePath, "utf8");
    const frontMatter = parseFrontMatter(content);

    if (!frontMatter?.name || !frontMatter?.description) {
      continue;
    }

    agents.push({
      id: relativePath.replace(/\//g, "__"),
      name: frontMatter.name,
      scene: categoryFromRelativePath(relativePath),
      version: `commit ${commit.slice(0, 7)}`,
      description: frontMatter.description,
      definitionText: content.trim(),
      tags: categoryFromRelativePath(relativePath).split("/"),
      repoSource: `${repoUrl}#${relativePath}`,
      relativePath,
    });
  }

  agents.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

  return {
    agents,
    commit,
    cacheRoot,
    repoUrl,
    warning,
  };
}

async function initializeWorkspace(payload) {
  const company = sanitizePathSegment(payload.company);
  const department = sanitizePathSegment(payload.department);
  const employeeName = sanitizePathSegment(payload.employeeName);
  const projectName = sanitizePathSegment(payload.projectName);
  const projectRoot = String(payload.projectRoot || "").replace(/[\\/]+$/, "");

  if (!projectRoot) {
    throw new Error("projectRoot is required");
  }

  const workspacePath = path.join(projectRoot, company, department, employeeName, projectName);
  const artifactsDir = path.join(workspacePath, "artifacts");
  const referencesDir = path.join(workspacePath, "references");
  const runtimeDir = path.join(workspacePath, "runtime");
  const createdAt = new Date().toISOString();

  await mkdir(artifactsDir, { recursive: true });
  await mkdir(referencesDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await ensureWorkspaceAgentsFile(projectRoot, workspacePath);

  const meta = {
    agentRepoSource: payload.repoSource ?? "",
    autoTrustWorkspace: payload.autoTrustWorkspace !== false,
    company,
    createdAt,
    department,
    elevationMode: payload.elevationMode ?? "manual",
    employeeCode: payload.employeeCode ?? "",
    employeeName,
    memberId: payload.memberId ?? "",
    permission: payload.permission ?? "",
    promptAutomation: payload.promptAutomation ?? "safe_auto",
    projectName,
    projectRoot: projectRoot.replace(/\\/g, "/"),
    role: payload.role ?? "",
    shell: payload.shell ?? "",
    status: "initialized",
    workStatus: "idle",
    lastAction: "initialize",
    stoppedAt: null,
    workspacePath: workspacePath.replace(/\\/g, "/"),
  };

  await ensureTextFile(
    path.join(workspacePath, "current.md"),
    `# 当前任务\n\n- 当前暂无任务\n- 创建时间：${createdAt}\n`,
  );
  await ensureTextFile(
    path.join(workspacePath, "plan.md"),
    buildDefaultPlanMarkdown(payload, createdAt),
  );
  await ensureTextFile(
    path.join(workspacePath, "workspace_guide.md"),
    buildWorkspaceGuideMarkdown(payload, createdAt),
  );
  await ensureTextFile(
    path.join(workspacePath, "task_request.md"),
    "# 原始任务\n\n- 当前暂无待解析需求\n",
  );
  await ensureTextFile(
    path.join(workspacePath, "startup_ack.md"),
    "# 首轮确认\n\n- 状态：待确认\n- 当前暂无新的首轮确认任务\n",
  );
  await ensureTextFile(
    path.join(workspacePath, "codex_bootstrap.md"),
    buildCodexBootstrapMarkdown(payload, createdAt),
  );
  await ensureTextFile(
    path.join(workspacePath, "restore_summary.md"),
    `# 恢复摘要\n\n- 生成时间：${createdAt}\n- 当前暂无恢复摘要\n`,
  );
  await ensureTextFile(
    path.join(workspacePath, "wait_finished.md"),
    "# 待完成任务\n\n- 暂无待办\n",
  );
  await ensureTextFile(
    path.join(workspacePath, "finished.md"),
    "# 已完成任务\n\n- 暂无记录\n",
  );
  await ensureTextFile(
    path.join(workspacePath, "block.md"),
    "# 阻塞记录\n\n- 暂无阻塞\n",
  );
  await ensureWorkspaceRoleFile(workspacePath, String(payload.agentDefinitionText || "").trim());
  await ensureTextFile(
    path.join(runtimeDir, "meta.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
  );

  await ensureEmployeeRootMetadata({
    agentDefinitionText: payload.agentDefinitionText,
    company,
    department,
    employeeCode: payload.employeeCode ?? "",
    employeeName,
    employeeRoot: path.dirname(workspacePath),
    memberId: payload.memberId ?? "",
    permission: payload.permission ?? "",
    projectName,
    projectWorkspacePath: workspacePath,
    repoSource: payload.repoSource ?? "",
    role: payload.role ?? "",
    shell: payload.shell ?? "",
  });

  return {
    created: true,
    files: [
      "AGENTS.md",
      "current.md",
      "plan.md",
      "workspace_guide.md",
      "task_request.md",
      "startup_ack.md",
      "codex_bootstrap.md",
      "restore_summary.md",
      "wait_finished.md",
      "finished.md",
      "block.md",
      "ROLE.md",
      "runtime/meta.json",
      "artifacts/",
      "references/",
    ],
    workspacePath: workspacePath.replace(/\\/g, "/"),
  };
}

function deriveEmployeeRootFromWorkspace(workspacePath) {
  return path.dirname(String(workspacePath || "").replace(/[\\/]+$/, ""));
}

function deriveProjectNameFromWorkspace(workspacePath) {
  return path.basename(String(workspacePath || "").replace(/[\\/]+$/, ""));
}

function employeeRootFiles(employeeRoot) {
  return {
    legacyAgentPath: path.join(employeeRoot, "agent.md"),
    rolePath: path.join(employeeRoot, "ROLE.md"),
    currentProjectPath: path.join(employeeRoot, "current-project.json"),
    deliveriesIndexPath: path.join(employeeRoot, "deliveries-index.json"),
    dispatchQueuePath: path.join(employeeRoot, "dispatch-queue.json"),
    employeeProfilePath: path.join(employeeRoot, "employee.json"),
  };
}

async function ensureEmployeeRootMetadata({
  agentDefinitionText,
  company,
  department,
  employeeCode,
  employeeName,
  employeeRoot,
  memberId,
  permission,
  projectName,
  projectWorkspacePath,
  repoSource,
  role,
  shell,
}) {
  const files = employeeRootFiles(employeeRoot);
  const normalizedEmployeeRoot = employeeRoot.replace(/\\/g, "/");

  await ensureTextFile(
    files.rolePath,
    normalizeMarkdownContent(agentDefinitionText, "# ROLE.md\n\n待补充\n"),
  );

  await ensureTextFile(
    files.employeeProfilePath,
    `${JSON.stringify(
      {
        company,
        createdAt: new Date().toISOString(),
        department,
        employeeCode,
        employeeName,
        memberId,
        permission,
        repoSource,
        role,
        shell,
        employeeRoot: normalizedEmployeeRoot,
      },
      null,
      2,
    )}\n`,
  );

  await ensureTextFile(
    files.currentProjectPath,
    `${JSON.stringify(
      {
        projectName,
        updatedAt: new Date().toISOString(),
        workspacePath: projectWorkspacePath.replace(/\\/g, "/"),
      },
      null,
      2,
    )}\n`,
  );

  await ensureTextFile(
    files.dispatchQueuePath,
    `${JSON.stringify({ items: [], updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  await ensureTextFile(
    files.deliveriesIndexPath,
    `${JSON.stringify({ items: [], updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function updateCurrentProjectPointer(employeeRoot, workspacePath) {
  const files = employeeRootFiles(employeeRoot);
  await writeJsonFile(files.currentProjectPath, {
    projectName: deriveProjectNameFromWorkspace(workspacePath),
    updatedAt: new Date().toISOString(),
    workspacePath: workspacePath.replace(/\\/g, "/"),
  });
}

async function enqueueEmployeeProjectDispatch(employeeRoot, entry) {
  const files = employeeRootFiles(employeeRoot);
  const current = await readJsonFile(files.dispatchQueuePath, {
    items: [],
    updatedAt: null,
  });

  const normalizedItems = Array.isArray(current.items) ? current.items : [];
  const duplicate = normalizedItems.find(
    (item) =>
      item.workspacePath === entry.workspacePath &&
      item.taskSummary === entry.taskSummary &&
      item.status !== "done",
  );

  if (duplicate) {
    return current;
  }

  const next = {
    items: [
      ...normalizedItems,
      {
        createdAt: entry.createdAt,
        deadlineAt: entry.deadlineAt ?? null,
        priority: entry.priority ?? "P1",
        projectName: entry.projectName,
        source: entry.source ?? "手动发布",
        status: entry.status ?? "queued",
        taskSummary: entry.taskSummary,
        timeWindow: entry.timeWindow ?? "3 小时内",
        workspacePath: entry.workspacePath.replace(/\\/g, "/"),
      },
    ],
    updatedAt: new Date().toISOString(),
  };

  await writeJsonFile(files.dispatchQueuePath, next);
  return next;
}

async function popNextEmployeeProjectDispatch(employeeRoot) {
  const files = employeeRootFiles(employeeRoot);
  const current = await readJsonFile(files.dispatchQueuePath, {
    items: [],
    updatedAt: null,
  });
  const items = Array.isArray(current.items) ? current.items : [];
  if (items.length === 0) {
    return null;
  }

  const [nextItem, ...rest] = items;
  await writeJsonFile(files.dispatchQueuePath, {
    items: rest,
    updatedAt: new Date().toISOString(),
  });
  return nextItem;
}

async function appendDeliveryIndex(employeeRoot, delivery) {
  const files = employeeRootFiles(employeeRoot);
  const current = await readJsonFile(files.deliveriesIndexPath, {
    items: [],
    updatedAt: null,
  });
  const items = Array.isArray(current.items) ? current.items : [];
  const next = {
    items: [
      {
        completedAt: delivery.completedAt,
        filePath: delivery.filePath.replace(/\\/g, "/"),
        projectName: delivery.projectName,
        title: delivery.title,
        workspacePath: delivery.workspacePath.replace(/\\/g, "/"),
      },
      ...items,
    ].slice(0, 200),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(files.deliveriesIndexPath, next);
}

async function ensureProjectWorkspaceForAssignment(currentWorkspacePath, projectName) {
  const currentMetaPath = path.join(currentWorkspacePath, "runtime", "meta.json");
  const currentMeta = await readJsonFile(currentMetaPath, {});
  const employeeRoot = deriveEmployeeRootFromWorkspace(currentWorkspacePath);
  const files = employeeRootFiles(employeeRoot);
  const employeeProfile = await readJsonFile(files.employeeProfilePath, currentMeta);
  const roleDefinitionText = await resolveRoleDefinitionText(currentWorkspacePath, employeeRoot);

  const result = await initializeWorkspace({
    agentDefinitionText: roleDefinitionText,
    autoTrustWorkspace: employeeProfile.autoTrustWorkspace,
    company: employeeProfile.company ?? currentMeta.company ?? path.basename(path.dirname(employeeRoot)),
    department: employeeProfile.department ?? currentMeta.department ?? path.basename(employeeRoot),
    elevationMode: employeeProfile.elevationMode ?? currentMeta.elevationMode,
    employeeCode: employeeProfile.employeeCode ?? currentMeta.employeeCode ?? "",
    employeeName: employeeProfile.employeeName ?? currentMeta.employeeName ?? path.basename(employeeRoot),
    memberId: employeeProfile.memberId ?? currentMeta.memberId ?? "",
    permission: employeeProfile.permission ?? currentMeta.permission ?? "受限模式",
    projectName,
    projectRoot: deriveProjectRootFromEmployeeRoot(employeeRoot),
    promptAutomation: employeeProfile.promptAutomation ?? currentMeta.promptAutomation,
    repoSource: employeeProfile.agentRepoSource ?? currentMeta.agentRepoSource ?? "",
    role: employeeProfile.role ?? currentMeta.role ?? "实现执行",
    shell: employeeProfile.shell ?? currentMeta.shell ?? "PowerShell 7.5",
  });

  return result.workspacePath;
}

async function resolveShell(shell) {
  if (shell && shell.trim()) {
    const normalized = shell.trim().toLowerCase();

    if (process.platform === "win32") {
      if (normalized === "powershell 7.5" || normalized === "powershell 7" || normalized === "pwsh") {
        if (await commandExists("pwsh.exe")) {
          return "pwsh.exe";
        }
        return "powershell.exe";
      }

      if (normalized === "cmd") {
        return "cmd.exe";
      }
    }

    return shell.trim();
  }

  if (process.platform === "win32") {
    if (await commandExists("pwsh.exe")) {
      return "pwsh.exe";
    }
    return "powershell.exe";
  }

  return process.env.SHELL || "bash";
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

async function resolveCodexWrapperShell(baseShell) {
  if (process.platform !== "win32") {
    return baseShell;
  }

  if (/pwsh|powershell/i.test(baseShell)) {
    return baseShell;
  }

  if (await commandExists("pwsh.exe")) {
    return "pwsh.exe";
  }

  return "powershell.exe";
}

async function buildCodexStartupPrompt(workspacePath) {
  const normalizedWorkspace = String(workspacePath).replace(/\\/g, "/");
  const sections = await Promise.all([
    readWorkspacePromptSection(workspacePath, "task_request.md", 4000),
    readWorkspacePromptSection(workspacePath, "restore_summary.md", 4000),
  ]);

  return [
    "你现在是一个已经应用了员工 Agent 定义的 Codex CLI 会话。",
    `当前项目空间：${normalizedWorkspace}`,
    "项目空间中的 AGENTS.md 会作为长期规则自动生效，但你仍然要主动阅读 ROLE.md。",
    "启动后请先阅读 AGENTS.md、ROLE.md 和 task_request.md；如果任务里列出了 references/ 资料，也要优先查看。",
    "下面只附带最关键的任务与恢复摘要，避免在会话初始化时注入过多上下文。",
    "你的第一步不是立刻执行，而是先根据 task_request.md 生成或更新 plan.md。",
    "在完成计划之前，不要把自己当作普通 shell 去直接执行任务。",
    "所有真实产出物必须写入 artifacts/ 目录。",
    "进入会话后，请先用 3 到 6 行总结任务、计划思路和阻塞项，再继续执行。",
    sections.join("\n\n"),
  ].join("\n\n");
}

function buildCodexPermissionArgs(permission) {
  if (permission === "完全权限") {
    return ["-a", "never", "-s", "danger-full-access"];
  }

  return ["-a", "never", "-s", "workspace-write"];
}

function buildCodexExecPermissionArgs(permission) {
  if (permission === "完全权限") {
    return ["-s", "danger-full-access"];
  }

  return ["-s", "workspace-write"];
}

function buildCodexImageArgs(imagePaths) {
  const normalizedPaths = Array.isArray(imagePaths)
    ? imagePaths.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  return normalizedPaths.length > 0 ? ["-i", ...normalizedPaths] : [];
}

function buildStartupAckExecPrompt(workspacePath) {
  const normalizedWorkspace = String(workspacePath).replace(/\\/g, "/");
  return [
    "你现在负责完成员工会话的首轮接单确认。",
    `当前项目空间：${normalizedWorkspace}`,
    "请只做下面三件事：",
    "1. 阅读 task_request.md 和 startup_ack.md。",
    "2. 更新 startup_ack.md，把状态改成“已确认”，并补充任务理解摘要、计划状态（未生成或已生成）、下一步动作。",
    "3. 不要修改除 startup_ack.md 之外的任何文件。",
    "完成后直接结束，不要继续执行任务。",
  ].join("\n");
}

async function runStartupAckPreflight({ cwd, permission, shell }) {
  const startupAckPath = path.join(cwd, "startup_ack.md");
  const taskRequestPath = path.join(cwd, "task_request.md");

  if (!existsSync(startupAckPath) || !existsSync(taskRequestPath)) {
    return false;
  }

  const startupAckContent = await readWorkspaceFileContent(cwd, "startup_ack.md");
  if (parseStartupAckStatus(startupAckContent) !== "pending_ack") {
    return false;
  }

  if (!(await commandExists("codex"))) {
    return false;
  }

  await writeFile(
    startupAckPath,
    updateStartupAckContent(startupAckContent, "确认中"),
    "utf8",
  );

  const execPrompt = buildStartupAckExecPrompt(cwd);

  try {
    if (process.platform === "win32") {
      const wrapperShell = await resolveCodexWrapperShell(shell);
      const quotedCwd = escapePowerShellSingleQuoted(cwd);
      const quotedPrompt = escapePowerShellSingleQuoted(execPrompt);
      const permissionArgs = buildCodexExecPermissionArgs(permission)
        .map((value) => `'${escapePowerShellSingleQuoted(value)}'`)
        .join(", ");

      await execFileAsync(
        wrapperShell,
        [
          "-NoLogo",
          "-NoProfile",
          "-Command",
          `$execArgs = @('exec', '--skip-git-repo-check', '--ephemeral', '-C', '${quotedCwd}', '-c', 'model_reasoning_effort=\"minimal\"', ${permissionArgs}, '${quotedPrompt}'); & codex @execArgs`,
        ],
        {
          cwd,
          windowsHide: true,
          timeout: STARTUP_ACK_TIMEOUT_MS,
        },
      );
    } else {
      await execFileAsync(
        "codex",
        [
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "-C",
          cwd,
          "-c",
          'model_reasoning_effort="minimal"',
          ...buildCodexExecPermissionArgs(permission),
          execPrompt,
        ],
      {
        cwd,
        timeout: STARTUP_ACK_TIMEOUT_MS,
      },
    );
  }

    const latestContent = await readWorkspaceFileContent(cwd, "startup_ack.md");
    const latestStatus = parseStartupAckStatus(latestContent);
    if (latestStatus === "pending_ack" || latestStatus === "confirming") {
      await writeFile(
        startupAckPath,
        updateStartupAckContent(latestContent, "已确认"),
        "utf8",
      );
    }
  } catch (error) {
    const latestContent = await readWorkspaceFileContent(cwd, "startup_ack.md");
    const message = error instanceof Error ? error.message : "首轮确认失败";
    await writeFile(
      startupAckPath,
      updateStartupAckContent(latestContent, "确认失败", message),
      "utf8",
    );
    throw error;
  }

  return true;
}

async function resolveRuntimeLaunch({ cwd, permission, shell }) {
  const resolvedShell = await resolveShell(shell);
  const resolvedCwd = resolveCwd(cwd);
  const projectRoot = deriveProjectRootFromWorkspace(resolvedCwd);
  await ensureWorkspaceAgentsFile(projectRoot, resolvedCwd);
  const roleDefinitionText = await resolveRoleDefinitionText(resolvedCwd);
  if (roleDefinitionText.trim()) {
    await ensureWorkspaceRoleFile(resolvedCwd, roleDefinitionText);
  }

  const runtimeMeta = await readJsonFile(path.join(resolvedCwd, "runtime", "meta.json"), {});
  const startupImagePaths = Array.isArray(runtimeMeta?.lastAssignedReferences)
    ? runtimeMeta.lastAssignedReferences
        .filter((reference) => Boolean(reference?.isImage))
        .map((reference) => String(reference?.absolutePath || "").trim())
        .filter((absolutePath) => absolutePath && existsSync(absolutePath))
        .slice(0, 4)
    : [];
  const codexImageArgs = buildCodexImageArgs(startupImagePaths);
  const hasWorkspaceRules = existsSync(path.join(resolvedCwd, "AGENTS.md"));
  const hasRoleDefinition = existsSync(path.join(resolvedCwd, "ROLE.md"));
  const codexAvailable = await commandExists("codex");

  if (codexAvailable && hasWorkspaceRules && hasRoleDefinition) {
    void runStartupAckPreflight({
      cwd: resolvedCwd,
      permission,
      shell: resolvedShell,
    }).catch(() => false);

    const codexBootstrapPath = path.join(resolvedCwd, "codex_bootstrap.md");
    const restoreSummaryPath = path.join(resolvedCwd, "restore_summary.md");
    const restoreSummaryContent = await buildRestoreSummaryMarkdown(resolvedCwd);
    await writeFile(
      restoreSummaryPath,
      `${restoreSummaryContent}\n`,
      "utf8",
    );
    const codexStartupPrompt = await buildCodexStartupPrompt(resolvedCwd);
    await writeFile(
      codexBootstrapPath,
      `${codexStartupPrompt}\n`,
      "utf8",
    );

    if (process.platform === "win32") {
      const wrapperShell = await resolveCodexWrapperShell(resolvedShell);
      const quotedBootstrapPath = escapePowerShellSingleQuoted(codexBootstrapPath);
      const quotedCwd = escapePowerShellSingleQuoted(resolvedCwd);
      const permissionArgs = buildCodexPermissionArgs(permission)
        .map((value) => `'${escapePowerShellSingleQuoted(value)}'`)
        .join(", ");
      const imageArgs = codexImageArgs
        .map((value) => `'${escapePowerShellSingleQuoted(value)}'`)
        .join(", ");
      const extraImageArgs = imageArgs ? `${imageArgs}, ` : "";

      return {
        args: [
          "-NoLogo",
          "-NoExit",
          "-Command",
          `$bootstrapPrompt = Get-Content -LiteralPath '${quotedBootstrapPath}' -Raw; $codexArgs = @('--no-alt-screen', '-C', '${quotedCwd}', ${extraImageArgs}${permissionArgs}, $bootstrapPrompt); & codex @codexArgs`,
        ],
        command: wrapperShell,
        cwd: resolvedCwd,
        launchMode: "codex",
        resolvedShell: "codex",
      };
    }

      return {
        args: [
          "--no-alt-screen",
          "-C",
          resolvedCwd,
          ...codexImageArgs,
          ...buildCodexPermissionArgs(permission),
          codexStartupPrompt,
        ],
        command: "codex",
        cwd: resolvedCwd,
      launchMode: "codex",
      resolvedShell: "codex",
    };
  }

  return {
    args: [],
    command: resolvedShell,
    cwd: resolvedCwd,
    launchMode: "shell",
    resolvedShell,
  };
}

function resolveCwd(cwd) {
  if (cwd && existsSync(cwd)) {
    return cwd;
  }

  return process.cwd();
}

function createHistoryItem(type, data) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type,
    data,
  };
}

function pushHistory(session, item) {
  session.history.push(item);
  if (session.history.length > HISTORY_LIMIT) {
    session.history.splice(0, session.history.length - HISTORY_LIMIT);
  }
}

function buildPendingPrompt(session, prompt) {
  return {
    createdAt: new Date().toISOString(),
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    memberId: session.memberId,
    responseMode: prompt.responseMode,
    summary: prompt.summary,
    title: prompt.title,
    type: prompt.type,
    workspacePath: session.cwd.replace(/\\/g, "/"),
  };
}

function pushPromptHandlingLog(entry) {
  promptHandlingLogs.unshift({
    action: entry.action,
    createdAt: new Date().toISOString(),
    memberId: entry.memberId,
    mode: entry.mode,
    summary: entry.summary,
    title: entry.title,
    workspacePath: entry.workspacePath,
  });

  if (promptHandlingLogs.length > PROMPT_LOG_LIMIT) {
    promptHandlingLogs.splice(PROMPT_LOG_LIMIT);
  }
}

function listPendingPrompts() {
  return Array.from(pendingPrompts.values()).sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

function listPromptHandlingLogs() {
  return [...promptHandlingLogs];
}

function clearPendingPromptByMember(memberId, type) {
  for (const [id, prompt] of pendingPrompts.entries()) {
    if (prompt.memberId === memberId && prompt.type === type) {
      pendingPrompts.delete(id);
    }
  }
}

function ensurePendingPrompt(session, prompt) {
  const existing = Array.from(pendingPrompts.values()).find(
    (item) => item.memberId === session.memberId && item.type === prompt.type,
  );
  if (existing) {
    return existing;
  }

  const nextPrompt = buildPendingPrompt(session, prompt);
  pendingPrompts.set(nextPrompt.id, nextPrompt);
  return nextPrompt;
}

function tryAutoRespond(session, type, command) {
  clearPendingPromptByMember(session.memberId, type);
  try {
    session.pty.write(command);
    return true;
  } catch {
    return false;
  }
}

function promptRuleActionToCommand(action) {
  switch (action) {
    case "enter":
      return "\r";
    case "reply_1":
      return "1\r";
    case "reply_2":
      return "2\r";
    case "reply_y":
      return "y\r";
    case "reply_n":
      return "n\r";
    default:
      return null;
  }
}

function tryApplyUserPromptRules(session) {
  const rules = Array.isArray(session.promptRules) ? session.promptRules : [];
  const normalizedBuffer = String(session.codexOutputBuffer || "").toLowerCase();

  for (const rule of rules) {
    if (!rule?.enabled || !rule.pattern) {
      continue;
    }

    if (!normalizedBuffer.includes(String(rule.pattern).toLowerCase())) {
      continue;
    }

    if (rule.action === "route_pending") {
      ensurePendingPrompt(session, {
        responseMode: "notify_only",
        summary: `命中白名单规则“${rule.name}”，当前转入待确认中心等待人工处理。`,
        title: `白名单规则：${rule.name}`,
        type: `custom_rule:${rule.id}`,
      });
      session.codexOutputBuffer = "";
      return true;
    }

    const command = promptRuleActionToCommand(rule.action);
    if (!command) {
      continue;
    }

    if (tryAutoRespond(session, `custom_rule:${rule.id}`, command)) {
      pushPromptHandlingLog({
        action: rule.action,
        memberId: session.memberId,
        mode: "白名单自动处理",
        summary: `命中规则“${rule.name}”，已按预设动作处理。`,
        title: `白名单规则：${rule.name}`,
        workspacePath: session.cwd.replace(/\\/g, "/"),
      });
      session.codexOutputBuffer = "";
      return true;
    }
  }

  return false;
}

function processSessionPromptSignals(session, data) {
  if (session.launchMode !== "codex") {
    return;
  }

  session.codexOutputBuffer = `${session.codexOutputBuffer || ""}${String(data || "")}`.slice(-4000);

  if (
    /Do you trust the contents of this directory\?/i.test(session.codexOutputBuffer)
  ) {
    if (session.automationSettings.autoTrustWorkspace) {
      if (tryAutoRespond(session, "trust_directory", "1\r")) {
        pushPromptHandlingLog({
          action: "批准",
          memberId: session.memberId,
          mode: "自动处理",
          summary: "Codex 目录信任提示已自动确认。",
          title: "信任工作空间",
          workspacePath: session.cwd.replace(/\\/g, "/"),
        });
        session.codexOutputBuffer = "";
      }
      return;
    }

    ensurePendingPrompt(session, {
      responseMode: "approve_reject",
      summary: "Codex 正在询问是否信任当前员工工作空间。",
      title: "信任工作空间",
      type: "trust_directory",
    });
    session.codexOutputBuffer = "";
    return;
  }

  if (/Press enter to continue/i.test(session.codexOutputBuffer)) {
    if (session.automationSettings.promptAutomation === "safe_auto") {
      if (tryAutoRespond(session, "press_enter_continue", "\r")) {
        pushPromptHandlingLog({
          action: "继续执行",
          memberId: session.memberId,
          mode: "自动处理",
          summary: "命中安全提示，已自动按回车继续。",
          title: "继续执行提示",
          workspacePath: session.cwd.replace(/\\/g, "/"),
        });
        session.codexOutputBuffer = "";
      }
      return;
    }

    ensurePendingPrompt(session, {
      responseMode: "continue_only",
      summary: "CLI 正在等待确认继续执行。",
      title: "继续执行提示",
      type: "press_enter_continue",
    });
    session.codexOutputBuffer = "";
    return;
  }

  if (
    /requires approval|needs your approval|elevated permissions|permission required/i.test(
      session.codexOutputBuffer,
    )
  ) {
    if (
      session.permission === "完全权限" &&
      session.automationSettings.elevationMode === "auto_if_full_access"
    ) {
      if (tryAutoRespond(session, "elevation_review", "1\r")) {
        pushPromptHandlingLog({
          action: "批准",
          memberId: session.memberId,
          mode: "自动处理",
          summary: "完全权限员工已按策略自动批准提权提示。",
          title: "提权确认提示",
          workspacePath: session.cwd.replace(/\\/g, "/"),
        });
        session.codexOutputBuffer = "";
      }
      return;
    }

    ensurePendingPrompt(session, {
      responseMode: "approve_reject",
      summary: "检测到提权或权限确认提示，可在这里集中批准或拒绝。",
      title: "提权确认提示",
      type: "elevation_review",
    });
    session.codexOutputBuffer = "";
    return;
  }

  tryApplyUserPromptRules(session);
}

function sendMessage(target, message) {
  if (target.readyState === target.OPEN) {
    target.send(JSON.stringify(message));
  }
}

function broadcast(session, message) {
  for (const client of session.clients) {
    sendMessage(client, message);
  }
}

function terminateSession(memberId) {
  const session = sessions.get(memberId);
  if (!session) {
    clearPendingPromptByMember(memberId, "trust_directory");
    clearPendingPromptByMember(memberId, "press_enter_continue");
    clearPendingPromptByMember(memberId, "elevation_review");
    return;
  }

  try {
    session.pty.kill();
  } catch {
    // ignore kill errors
  }

  for (const client of session.clients) {
    try {
      client.close();
    } catch {
      // ignore close errors
    }
  }

  sessions.delete(memberId);
  clearPendingPromptByMember(memberId, "trust_directory");
  clearPendingPromptByMember(memberId, "press_enter_continue");
  clearPendingPromptByMember(memberId, "elevation_review");
}

async function restartSession(payload) {
  const memberId = payload.memberId;
  if (!memberId || typeof memberId !== "string") {
    throw new Error("memberId is required");
  }

  terminateSession(memberId);
  const { session, reused } = await ensureSession({
    cols: Number(payload.cols) || DEFAULT_COLS,
    cwd: payload.cwd,
    memberId,
    permission: payload.permission,
    rows: Number(payload.rows) || DEFAULT_ROWS,
    shell: payload.shell,
  });

  if (payload.cwd) {
    await mergeJsonFile(path.join(payload.cwd, "runtime", "meta.json"), {
      lastAction: "restart",
      launchMode: session.launchMode,
      memberId,
      pid: session.pid,
      resolvedShell: session.shell,
      sessionId: session.id,
      startedAt: session.startedAt,
      status: "running",
      stoppedAt: null,
    });
  }

  return {
    cwd: session.cwd,
    pid: session.pid,
    reused,
    launchMode: session.launchMode,
    resolvedShell: session.shell,
    sessionId: session.id,
    startedAt: session.startedAt,
    started: true,
  };
}

async function updateWorkspaceMemberConfig(payload) {
  const workspacePath = String(payload.workspacePath || "").replace(/[\\/]+$/, "");
  if (!workspacePath) {
    throw new Error("workspacePath is required");
  }

  const metaPath = path.join(workspacePath, "runtime", "meta.json");
  const patch = {};

  if (typeof payload.permission === "string" && payload.permission.trim()) {
    patch.permission = payload.permission.trim();
  }
  if (typeof payload.autoTrustWorkspace === "boolean") {
    patch.autoTrustWorkspace = payload.autoTrustWorkspace;
  }
  if (typeof payload.promptAutomation === "string" && payload.promptAutomation.trim()) {
    patch.promptAutomation = payload.promptAutomation.trim();
  }
  if (typeof payload.elevationMode === "string" && payload.elevationMode.trim()) {
    patch.elevationMode = payload.elevationMode.trim();
  }

  await mergeJsonFile(metaPath, patch);

  if (payload.memberId && sessions.has(payload.memberId)) {
    const session = sessions.get(payload.memberId);
    session.automationSettings = {
      ...session.automationSettings,
      ...("autoTrustWorkspace" in patch ? { autoTrustWorkspace: patch.autoTrustWorkspace } : {}),
      ...("elevationMode" in patch ? { elevationMode: patch.elevationMode } : {}),
      ...("promptAutomation" in patch ? { promptAutomation: patch.promptAutomation } : {}),
    };
    if ("permission" in patch) {
      session.permission = patch.permission;
    }
  }

  return {
    ok: true,
    ...patch,
    workspacePath: workspacePath.replace(/\\/g, "/"),
  };
}

async function respondPendingPrompt(payload) {
  const promptId = String(payload.promptId || "").trim();
  const action = String(payload.action || "").trim();

  if (!promptId) {
    throw new Error("promptId is required");
  }

  const prompt = pendingPrompts.get(promptId);
  if (!prompt) {
    throw new Error("pending prompt not found");
  }

  const session = sessions.get(prompt.memberId);
  if (!session) {
    pendingPrompts.delete(promptId);
    throw new Error("对应员工当前没有活动会话");
  }

  let command = null;
  if (prompt.type === "trust_directory") {
    if (action === "approve") {
      command = "1\r";
    } else if (action === "reject") {
      command = "2\r";
    }
  } else if (prompt.type === "press_enter_continue") {
    if (action === "continue" || action === "approve") {
      command = "\r";
    }
  } else if (prompt.type === "elevation_review") {
    if (action === "approve") {
      command = "1\r";
    } else if (action === "reject") {
      command = "2\r";
    } else if (action === "dismiss") {
      pendingPrompts.delete(promptId);
      pushPromptHandlingLog({
        action: "忽略",
        memberId: prompt.memberId,
        mode: "人工处理",
        summary: prompt.summary,
        title: prompt.title,
        workspacePath: prompt.workspacePath,
      });
      return { action, ok: true, promptId };
    }
  }

  if (!command) {
    throw new Error("当前提示不支持该操作");
  }

  session.pty.write(command);
  pendingPrompts.delete(promptId);
  pushPromptHandlingLog({
    action,
    memberId: prompt.memberId,
    mode: "人工处理",
    summary: prompt.summary,
    title: prompt.title,
    workspacePath: prompt.workspacePath,
  });
  return {
    action,
    memberId: prompt.memberId,
    ok: true,
    promptId,
  };
}

async function ensureSession({
  cols = DEFAULT_COLS,
  cwd,
  memberId,
  permission,
  rows = DEFAULT_ROWS,
  shell,
}) {
  const existing = sessions.get(memberId);
  if (existing) {
    existing.lastActiveAt = Date.now();
    return { session: existing, reused: true };
  }

  const launchTarget = await resolveRuntimeLaunch({
    cwd,
    permission,
    shell,
  });
  const runtimeConfiguration = await readRuntimeConfiguration(launchTarget.cwd);
  const ptyProcess = pty.spawn(launchTarget.command, launchTarget.args, {
    cols,
    rows,
    cwd: launchTarget.cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      CCLIENT_MEMBER_ID: memberId,
    },
    name: "xterm-color",
  });

  const session = {
    id: createSessionId(),
    automationSettings: runtimeConfiguration.automationSettings,
    launchMode: launchTarget.launchMode,
    memberId,
    codexOutputBuffer: "",
    pid: ptyProcess.pid,
    permission,
    projectRoot: runtimeConfiguration.projectRoot,
    promptRules: runtimeConfiguration.promptRules,
    shell: launchTarget.resolvedShell,
    startedAt: new Date().toISOString(),
    cwd: launchTarget.cwd,
    cols,
    rows,
    pty: ptyProcess,
    clients: new Set(),
    history: [],
    lastActiveAt: Date.now(),
  };

  pushHistory(
    session,
    createHistoryItem(
      "meta",
      `[bridge] session ready on ${os.hostname()} using ${launchTarget.resolvedShell}`,
    ),
  );

  ptyProcess.onData((data) => {
    session.lastActiveAt = Date.now();
    processSessionPromptSignals(session, data);
    const item = createHistoryItem("output", data);
    pushHistory(session, item);
    broadcast(session, { type: "output", data, memberId });
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    const meta = `\r\n[bridge] session exited (code=${exitCode}, signal=${signal ?? "none"})\r\n`;
    pushHistory(session, createHistoryItem("meta", meta));
    broadcast(session, { type: "output", data: meta, memberId });
    broadcast(session, { type: "exit", exitCode, signal, memberId });
    sessions.delete(memberId);
  });

  sessions.set(memberId, session);
  return { session, reused: false };
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Headers": "Content-Type, X-CClient-Key",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Origin": "*",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, {
      ok: true,
      bridgePort: BRIDGE_PORT,
      sessionCount: sessions.size,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/settings/root") {
    try {
      const result = getSettingsRootState({});
      writeJson(response, 200, result);
    } catch (error) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : "settings root resolve failed",
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/settings/security/load") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const result = await loadSecurityConfig(payload.projectRoot);
        writeJson(response, 200, {
          enabled: result.enabled,
          filePath: result.filePath,
        });
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "security load failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/settings/security/save") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const result = await saveSecurityConfig(
          payload.projectRoot,
          payload,
          extractProvidedApiKey(request, url),
        );
        writeJson(response, 200, {
          enabled: result.enabled,
          filePath: result.filePath,
        });
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "security save failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/terminate") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        if (payload.memberId) {
          terminateSession(payload.memberId);
        }
        response.writeHead(204, {
          "Access-Control-Allow-Headers": "Content-Type, X-CClient-Key",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Origin": "*",
        });
        response.end();
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "invalid payload",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/settings/codex/load") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await loadCodexSettings();
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "codex settings load failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/settings/codex/save") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await saveCodexSettings(payload);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "codex settings save failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/settings/codex/test") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await testCodexSettings(payload);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "codex settings test failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent-repo/list") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const repoUrl = payload.repoUrl;
        const cacheRoot = typeof payload.cacheRoot === "string" && payload.cacheRoot.trim()
          ? payload.cacheRoot
          : AGENT_REPO_CACHE_ROOT;

        if (!repoUrl || typeof repoUrl !== "string") {
          writeJson(response, 400, { error: "repoUrl is required" });
          return;
        }

        const result = await parseAgentDefinitions(
          repoUrl,
          Boolean(payload.refresh),
          cacheRoot,
        );
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 500, {
          error: error instanceof Error ? error.message : "repo sync failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/workspace/init") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await initializeWorkspace(payload);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "workspace init failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/workspace/discover") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await discoverWorkspaces(payload.projectRoot);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "workspace discover failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/workspace/history") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await listWorkspaceHistory(payload.workspacePath);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "workspace history failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/workspace/projects") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await listEmployeeProjectSpaces(payload.workspacePath);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "workspace projects failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/employee/info") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await getEmployeeInfo(payload.workspacePath);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "employee info failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/employee/status") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await getEmployeeStatus(payload.workspacePath);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "employee status failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/employee/tasks") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await getEmployeeTasks(payload.workspacePath);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "employee tasks failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/employee/projects") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await listEmployeeProjectSpaces(payload.workspacePath);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "employee projects failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/employee/projects/switch") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await switchEmployeeProject(payload);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "employee project switch failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/employee/deliveries") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await getEmployeeDeliveries(payload.workspacePath);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "employee deliveries failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/employee/delete") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await deleteEmployeeWorkspace(payload);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "employee delete failed",
        });
      }
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/download/file") {
    void (async () => {
      try {
        const targetPath = String(url.searchParams.get("path") || "").trim();
        const workspacePath = String(url.searchParams.get("workspacePath") || "").trim();
        const filename = String(url.searchParams.get("filename") || "").trim();

        if (!targetPath) {
          writeJson(response, 400, { error: "path is required" });
          return;
        }

        await ensureAuthorizedRequest(
          request,
          {
            path: targetPath,
            workspacePath,
          },
          url,
        );
        await streamFileDownload(
          response,
          targetPath,
          filename || path.basename(targetPath),
        );
      } catch (error) {
        if (!response.headersSent) {
          writeJson(response, 400, {
            error: error instanceof Error ? error.message : "file download failed",
          });
        } else {
          response.destroy();
        }
      }
    })();
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/download/archive") {
    void (async () => {
      try {
        const workspacePath = String(url.searchParams.get("workspacePath") || "").trim();
        const scope = String(url.searchParams.get("scope") || "project").trim();

        await ensureAuthorizedRequest(
          request,
          {
            workspacePath,
          },
          url,
        );
        await streamResultsArchiveDownload(response, workspacePath, scope);
      } catch (error) {
        if (!response.headersSent) {
          writeJson(response, 400, {
            error: error instanceof Error ? error.message : "archive download failed",
          });
        } else {
          response.destroy();
        }
      }
    })();
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/task/assign") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await assignTaskToWorkspace(payload);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "task assign failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/task/retry-startup-ack") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await retryStartupAck(payload);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "retry startup ack failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/task/complete") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await completeCurrentTask(payload);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "complete task failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runtime/start") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const memberId = payload.memberId;

        if (!memberId || typeof memberId !== "string") {
          writeJson(response, 400, { error: "memberId is required" });
          return;
        }

        const { session, reused } = await ensureSession({
          cols: Number(payload.cols) || DEFAULT_COLS,
          cwd: payload.cwd,
          memberId,
          permission: payload.permission,
          rows: Number(payload.rows) || DEFAULT_ROWS,
          shell: payload.shell,
        });

        if (payload.cwd) {
          await mergeJsonFile(path.join(payload.cwd, "runtime", "meta.json"), {
            lastAction: "start",
            launchMode: session.launchMode,
            memberId,
            pid: session.pid,
            resolvedShell: session.shell,
            sessionId: session.id,
            startedAt: session.startedAt,
            status: "running",
            stoppedAt: null,
          });
        }

        writeJson(response, 200, {
          cwd: session.cwd,
          launchMode: session.launchMode,
          pid: session.pid,
          reused,
          startedAt: session.startedAt,
          resolvedShell: session.shell,
          sessionId: session.id,
          started: true,
        });
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "runtime start failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runtime/stop") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const memberId = payload.memberId;

        if (!memberId || typeof memberId !== "string") {
          writeJson(response, 400, { error: "memberId is required" });
          return;
        }

        if (payload.cwd) {
          await mergeJsonFile(path.join(payload.cwd, "runtime", "meta.json"), {
            lastAction: "stop",
            pid: null,
            sessionId: null,
            status: "stopped",
            stoppedAt: new Date().toISOString(),
          });
        }

        terminateSession(memberId);
        writeJson(response, 200, {
          memberId,
          stopped: true,
        });
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "runtime stop failed",
        });
      }
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/runtime/prompts") {
    ensureAuthorizedRequest(request, {}, url)
      .then(() => {
        writeJson(response, 200, {
          logs: listPromptHandlingLogs(),
          prompts: listPendingPrompts(),
        });
      })
      .catch((error) => {
        writeJson(response, 401, {
          error: error instanceof Error ? error.message : "unauthorized",
        });
      });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runtime/prompts/respond") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await respondPendingPrompt(payload);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "prompt response failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/settings/prompt-rules/load") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await loadPromptRules(payload.projectRoot);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "prompt rules load failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/settings/prompt-rules/save") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await savePromptRules(payload.projectRoot, payload.rules);

        for (const session of sessions.values()) {
          if (
            session.projectRoot &&
            String(session.projectRoot).replace(/\\/g, "/").toLowerCase() ===
              String(payload.projectRoot || "").replace(/\\/g, "/").toLowerCase()
          ) {
            session.promptRules = result.rules;
          }
        }

        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "prompt rules save failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/workspace/member-config") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await updateWorkspaceMemberConfig(payload);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "member config update failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/path/open") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const targetPath = payload.path;

        if (!targetPath || typeof targetPath !== "string") {
          writeJson(response, 400, { error: "path is required" });
          return;
        }

        const openedPath = await openLocalPath(targetPath);
        writeJson(response, 200, { opened: true, path: openedPath });
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "open path failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runtime/restart") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await restartSession(payload);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "runtime restart failed",
        });
      }
    });
    return;
  }

  writeJson(response, 404, { error: "not found" });
});

const wss = new WebSocketServer({ server, path: "/terminal" });

wss.on("connection", async (socket, request) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  const attachOnly = url.searchParams.get("attachOnly") === "1";
  const memberId = url.searchParams.get("memberId");
  const shell = url.searchParams.get("shell") || undefined;
  const cwd = url.searchParams.get("cwd") || undefined;
  const cols = Number(url.searchParams.get("cols") || DEFAULT_COLS);
  const rows = Number(url.searchParams.get("rows") || DEFAULT_ROWS);

  if (!memberId) {
    sendMessage(socket, { type: "error", message: "memberId is required" });
    socket.close();
    return;
  }

  try {
    await ensureAuthorizedRequest(request, { cwd }, url);
  } catch (error) {
    sendMessage(socket, {
      type: "error",
      message: error instanceof Error ? error.message : "unauthorized",
    });
    socket.close();
    return;
  }

  let session;
  let reused = false;

  if (attachOnly) {
    const existing = sessions.get(memberId);
    if (!existing) {
      sendMessage(socket, {
        type: "error",
        message: "当前没有活动中的 CLI 会话，请先重启 CLI",
      });
      socket.close();
      return;
    }
    existing.lastActiveAt = Date.now();
    session = existing;
    reused = true;
  } else {
    const result = await ensureSession({ memberId, shell, cwd, cols, rows });
    session = result.session;
    reused = result.reused;
  }

  session.clients.add(socket);

  sendMessage(socket, {
    type: "ready",
    bridgePort: BRIDGE_PORT,
    cwd: session.cwd,
    launchMode: session.launchMode,
    memberId,
    reused,
    sessionId: session.id,
    shell: session.shell,
  });

  for (const item of session.history) {
    sendMessage(socket, {
      type: item.type,
      data: item.data,
      memberId,
    });
  }

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());

      if (message.type === "input" && typeof message.data === "string") {
        session.pty.write(message.data);
        return;
      }

      if (message.type === "resize") {
        const nextCols = Number(message.cols) || DEFAULT_COLS;
        const nextRows = Number(message.rows) || DEFAULT_ROWS;
        session.cols = nextCols;
        session.rows = nextRows;
        session.pty.resize(nextCols, nextRows);
        return;
      }

      if (message.type === "terminate") {
        terminateSession(memberId);
      }
    } catch {
      sendMessage(socket, {
        type: "error",
        message: "invalid bridge message",
      });
    }
  });

  socket.on("close", () => {
    session.clients.delete(socket);
    session.lastActiveAt = Date.now();
  });
});

server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
  console.log(
    `[c-client bridge] listening on http://${BRIDGE_HOST}:${BRIDGE_PORT} (ws /terminal)`,
  );
});
