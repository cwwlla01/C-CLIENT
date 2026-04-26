import "dotenv/config";
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
const CODEX_SESSION_DISCOVERY_MAX_FILES = 40;
const CODEX_SESSION_DISCOVERY_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;
const CODEX_SESSION_DISCOVERY_POLL_INTERVAL_MS = 1200;
const CODEX_SESSION_DISCOVERY_MAX_ATTEMPTS = 18;

const sessions = new Map();
const pendingPrompts = new Map();
const promptHandlingLogs = [];
const jsonMergeQueues = new Map();
const inspectorTimers = new Map();
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

function inspectorSettingsFilePath(projectRoot) {
  return path.join(projectRoot, "setting", "inspector.json");
}

function defaultInspectorSettings() {
  return {
    ai: {
      apiKey: "",
      baseUrl: "",
      enabled: false,
      maxTokens: 1200,
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
    },
    allowedReplyTypes: [
      "choice_ab",
      "choice_numeric",
      "confirm_yes_no",
    ],
    autoReplyEnabled: true,
    autopilotMode: "suggest_only",
    blockedReplyTypes: [
      "destructive_confirm",
      "mass_overwrite",
      "publish_confirm",
      "network_side_effect",
    ],
    enabled: true,
    highRiskAlwaysManual: true,
    inspectionMode: "rules_only",
    preferences: {
      preferConservative: true,
      preferContinue: true,
      preferNonDestructive: true,
      preferOptionA: false,
    },
    thresholds: {
      autoReplyScore: 80,
      blockedScore: 50,
      completionScore: 60,
      silenceSeconds: 20,
    },
  };
}

function sanitizeStringList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function sanitizeInspectorSettings(raw) {
  const defaults = defaultInspectorSettings();
  return {
    ai: {
      apiKey: String(raw?.ai?.apiKey || defaults.ai.apiKey),
      baseUrl: String(raw?.ai?.baseUrl || defaults.ai.baseUrl),
      enabled: raw?.ai?.enabled === true,
      maxTokens: Number(raw?.ai?.maxTokens || defaults.ai.maxTokens),
      model: String(raw?.ai?.model || defaults.ai.model),
      reasoningEffort: ["low", "medium", "high"].includes(String(raw?.ai?.reasoningEffort || ""))
        ? String(raw.ai.reasoningEffort)
        : defaults.ai.reasoningEffort,
    },
    allowedReplyTypes: sanitizeStringList(raw?.allowedReplyTypes).length > 0
      ? sanitizeStringList(raw.allowedReplyTypes)
      : defaults.allowedReplyTypes,
    autoReplyEnabled: raw?.autoReplyEnabled !== false,
    autopilotMode: ["off", "suggest_only", "safe_auto", "full_auto"].includes(String(raw?.autopilotMode || ""))
      ? String(raw.autopilotMode)
      : defaults.autopilotMode,
    blockedReplyTypes: sanitizeStringList(raw?.blockedReplyTypes).length > 0
      ? sanitizeStringList(raw.blockedReplyTypes)
      : defaults.blockedReplyTypes,
    enabled: raw?.enabled !== false,
    highRiskAlwaysManual: raw?.highRiskAlwaysManual !== false,
    inspectionMode: ["rules_only", "hybrid", "ai_only"].includes(String(raw?.inspectionMode || ""))
      ? String(raw.inspectionMode)
      : defaults.inspectionMode,
    preferences: {
      preferConservative: raw?.preferences?.preferConservative !== false,
      preferContinue: raw?.preferences?.preferContinue !== false,
      preferNonDestructive: raw?.preferences?.preferNonDestructive !== false,
      preferOptionA: raw?.preferences?.preferOptionA === true,
    },
    thresholds: {
      autoReplyScore: Number(raw?.thresholds?.autoReplyScore || defaults.thresholds.autoReplyScore),
      blockedScore: Number(raw?.thresholds?.blockedScore || defaults.thresholds.blockedScore),
      completionScore: Number(raw?.thresholds?.completionScore || defaults.thresholds.completionScore),
      silenceSeconds: Number(raw?.thresholds?.silenceSeconds || defaults.thresholds.silenceSeconds),
    },
  };
}

async function loadInspectorSettings(projectRoot) {
  const normalizedRoot = String(projectRoot || "").replace(/[\\/]+$/, "");
  const filePath = inspectorSettingsFilePath(normalizedRoot);

  try {
    const content = await readFile(filePath, "utf8");
    return {
      filePath: filePath.replace(/\\/g, "/"),
      settings: sanitizeInspectorSettings(JSON.parse(content)),
    };
  } catch {
    return {
      filePath: filePath.replace(/\\/g, "/"),
      settings: defaultInspectorSettings(),
    };
  }
}

async function saveInspectorSettings(projectRoot, settings) {
  const normalizedRoot = String(projectRoot || "").replace(/[\\/]+$/, "");
  if (!normalizedRoot) {
    throw new Error("projectRoot is required");
  }

  const settingDir = path.join(normalizedRoot, "setting");
  const filePath = inspectorSettingsFilePath(normalizedRoot);
  const normalizedSettings = sanitizeInspectorSettings(settings);

  await mkdir(settingDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(normalizedSettings, null, 2)}\n`, "utf8");

  return {
    filePath: filePath.replace(/\\/g, "/"),
    settings: normalizedSettings,
  };
}

async function callInspectorAiReview(settings, context) {
  const baseUrl = String(settings?.ai?.baseUrl || "").replace(/\/+$/, "");
  const apiKey = String(settings?.ai?.apiKey || "").trim();
  const model = String(settings?.ai?.model || "").trim();

  if (!settings?.ai?.enabled || !baseUrl || !apiKey || !model) {
    return null;
  }

  const prompt = [
    "你是本地运行时的观察者，只做简短评审，不生成长文。",
    "请根据以下上下文返回 JSON，不要返回 markdown。",
    "",
    "要求字段：",
    "- verdict: pass | risk | insufficient",
    "- summary: string",
    "- suggestions: string[]",
    "- risks: string[]",
    "- confidence: number (0~1)",
    "- reason: string",
    "- suggestedReply: string",
    "- replyConfidence: number (0~1)",
    "",
    "上下文：",
    JSON.stringify(context, null, 2),
  ].join("\n");

  const response = await fetch(`${baseUrl}/responses`, {
    headers: {
      ...buildCodexAuthHeaders(apiKey),
    },
    method: "POST",
    body: JSON.stringify({
      model,
      reasoning: {
        effort: settings.ai.reasoningEffort || "low",
      },
      text: {
        format: {
          type: "json_object",
        },
      },
      max_output_tokens: Number(settings.ai.maxTokens || 1200),
      input: prompt,
    }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Inspector AI 失败：${response.status} ${response.statusText}${rawText ? ` · ${rawText.slice(0, 200)}` : ""}`);
  }

  let parsed = null;
  try {
    const payload = JSON.parse(rawText);
    const outputText =
      payload?.output_text ||
      payload?.output?.[0]?.content?.[0]?.text ||
      payload?.content?.[0]?.text ||
      "";
    parsed = typeof outputText === "string" && outputText.trim() ? JSON.parse(outputText) : payload;
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  return {
    confidence:
      typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : null,
    reason: String(parsed.reason || "").trim(),
    risks: Array.isArray(parsed.risks) ? parsed.risks.map((item) => String(item)) : [],
    suggestedReply: String(parsed.suggestedReply || "").trim(),
    replyConfidence:
      typeof parsed.replyConfidence === "number"
        ? Math.max(0, Math.min(1, parsed.replyConfidence))
        : null,
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map((item) => String(item)) : [],
    summary: String(parsed.summary || "").trim(),
    verdict: ["pass", "risk", "insufficient"].includes(String(parsed.verdict || ""))
      ? String(parsed.verdict)
      : "insufficient",
  };
}

async function testInspectorSettings(payload) {
  const settings = sanitizeInspectorSettings(payload?.settings || {});
  const baseUrl = String(settings.ai.baseUrl || "").replace(/\/+$/, "");
  const apiKey = String(settings.ai.apiKey || "").trim();

  if (!baseUrl) {
    throw new Error("Inspector Base URL 不能为空");
  }
  if (!apiKey) {
    throw new Error("Inspector API Key 不能为空");
  }

  const startedAt = Date.now();
  const modelsUrl = `${baseUrl}/models`;
  const response = await fetch(modelsUrl, {
    headers: buildCodexAuthHeaders(apiKey),
    method: "GET",
  });
  const latencyMs = Date.now() - startedAt;
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Inspector 连通性测试失败：${response.status} ${response.statusText}${text ? ` · ${text.slice(0, 240)}` : ""}`,
    );
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  const models = Array.isArray(parsed?.data)
    ? parsed.data.map((item) => String(item?.id || "").trim()).filter(Boolean).slice(0, 8)
    : [];

  return {
    latencyMs,
    message: models.length > 0 ? `Inspector 连接成功，已识别 ${models.length} 个模型` : "Inspector 连接成功",
    modelCount: Array.isArray(parsed?.data) ? parsed.data.length : 0,
    models,
    ok: true,
    testedUrl: modelsUrl,
  };
}

function inspectorResultFilePath(workspacePath) {
  return path.join(workspacePath, "runtime", "inspector-last.json");
}

async function readInspectorResult(workspacePath) {
  return readJsonFile(inspectorResultFilePath(workspacePath), null);
}

async function ensureInspectorResult(workspacePath, session = null) {
  const current = await readInspectorResult(workspacePath);
  if (current) {
    return current;
  }
  return runInspectorForWorkspace(workspacePath, session);
}

function extractSessionOutputSnapshot(session, maxChars = 4000) {
  const historyItems = Array.isArray(session?.history) ? session.history : [];
  const chunks = historyItems
    .filter((item) => item?.type === "output" || item?.type === "meta")
    .slice(-40)
    .map((item) => String(item?.data || ""))
    .join("");
  return chunks.slice(-maxChars);
}

function detectPromptReturned(outputText) {
  const normalized = String(outputText || "");
  return /(^|\n)\s*[›>]\s/m.test(normalized);
}

function isObserverDecisionType(type) {
  return ["choice_ab", "choice_numeric", "confirm_yes_no"].includes(String(type || ""));
}

function extractTargetFileCandidates(taskText) {
  const normalized = String(taskText || "");
  const matches = new Set();
  const filePattern = /[`"'“”]?([A-Za-z0-9_\-/\\]+?\.[A-Za-z0-9]{1,8})[`"'“”]?/g;

  for (const match of normalized.matchAll(filePattern)) {
    const candidate = String(match[1] || "")
      .replace(/\\/g, "/")
      .replace(/^\.?\//, "")
      .trim();
    if (!candidate) {
      continue;
    }
    if (/^(http|https):/i.test(candidate)) {
      continue;
    }
    matches.add(candidate);
  }

  return Array.from(matches).slice(0, 12);
}

async function collectWorkspaceFiles(workspacePath) {
  const normalizedWorkspace = String(workspacePath || "").replace(/[\\/]+$/, "");
  const files = [];
  const queue = [normalizedWorkspace];

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
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }

      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        files.push(absolutePath.replace(/\\/g, "/"));
      }
    }
  }

  return files;
}

function detectReplyCandidate(outputText, preferences = {}) {
  const normalized = String(outputText || "");

  if (/delete|remove|rm\s+-|覆盖|overwrite|replace existing|destroy|drop table|publish|deploy|push to/i.test(normalized)) {
    return {
      riskLevel: "high",
      suggestedReply: "",
      summary: "命中高风险确认提示，建议人工处理。",
      type: "destructive_confirm",
    };
  }

  if (
    /方案\s*A[\s\S]{0,160}方案\s*B|A\s*or\s*B|选择\s*A\s*或\s*B|option\s*A[\s\S]{0,120}option\s*B|choose\s*A\s*or\s*B/i.test(
      normalized,
    )
  ) {
    const chooseA = preferences.preferOptionA !== false;
    return {
      riskLevel: "low",
      suggestedReply: chooseA ? "A" : "B",
      summary: chooseA ? "命中 A/B 选择，默认偏向 A。" : "命中 A/B 选择，默认偏向 B。",
      type: "choice_ab",
    };
  }

  if (
    /选择\s*1\s*或\s*2|press\s*1[\s\S]{0,120}press\s*2|1\/2|option\s*1[\s\S]{0,120}option\s*2|choose\s*1\s*or\s*2/i.test(
      normalized,
    )
  ) {
    return {
      riskLevel: "low",
      suggestedReply: preferences.preferConservative !== false ? "1" : "2",
      summary: "命中数字选项选择题。",
      type: "choice_numeric",
    };
  }

  if (/yes\/no|y\/n|是否继续|continue\?|继续吗|继续\?|继续还是停止/i.test(normalized)) {
    return {
      riskLevel: "medium",
      suggestedReply: preferences.preferContinue !== false ? "Yes, continue." : "No, stop and explain.",
      summary: "命中 yes/no 继续确认。",
      type: "confirm_yes_no",
    };
  }

  if (/Press enter to continue/i.test(normalized)) {
    return {
      riskLevel: "low",
      suggestedReply: "Enter",
      summary: "命中继续执行提示。",
      type: "continue_prompt",
    };
  }

  if (/Do you trust the contents of this directory\?/i.test(normalized)) {
    return {
      riskLevel: "low",
      suggestedReply: "1",
      summary: "命中目录信任提示。",
      type: "trust_prompt",
    };
  }

  return null;
}

async function buildInspectorResult(workspacePath, session = null) {
  const normalizedWorkspace = String(workspacePath || "").replace(/[\\/]+$/, "");
  if (!normalizedWorkspace) {
    return null;
  }

  const projectRoot = deriveProjectRootFromWorkspace(normalizedWorkspace);
  const inspectorConfig = await loadInspectorSettings(projectRoot);
  const settings = inspectorConfig.settings;
  const meta = await readJsonFile(path.join(normalizedWorkspace, "runtime", "meta.json"), {});
  const taskRequest = await readOptionalTextFile(path.join(normalizedWorkspace, "task_request.md"));
  const outputSnapshot = session ? extractSessionOutputSnapshot(session) : "";
  const now = Date.now();
  const lastActiveAtMs = session?.lastActiveAt
    ? Number(session.lastActiveAt)
    : meta.lastActiveAt
      ? Date.parse(String(meta.lastActiveAt))
      : meta.startedAt
        ? Date.parse(String(meta.startedAt))
        : now;
  const silenceSeconds = Math.max(0, Math.floor((now - (lastActiveAtMs || now)) / 1000));
  const promptReturned = detectPromptReturned(outputSnapshot);
  const artifacts = await listArtifactEntries(normalizedWorkspace);
  const workspaceFiles = await collectWorkspaceFiles(normalizedWorkspace);
  const taskSummary = String(meta.lastTaskSummary || "").trim();
  const targetFiles = extractTargetFileCandidates(taskRequest || taskSummary);
  const matchedTargetFiles = targetFiles.filter((target) =>
    workspaceFiles.some((filePath) => filePath.toLowerCase().endsWith(`/${target}`.toLowerCase()) || filePath.toLowerCase().endsWith(target.toLowerCase())),
  );
  const missingTargetFiles = targetFiles.filter((target) => !matchedTargetFiles.includes(target));
  const lastAutoReplyAt = String(meta.inspectorLastAutoReplyAt || "").trim() || null;
  let replyCandidate = detectReplyCandidate(outputSnapshot, settings.preferences);

  // `Press enter to continue` 和目录信任这类固定提示已经由运行时提示自动化处理，
  // 观察者不再重复介入，避免出现反复建议/回车的体验问题。
  if (replyCandidate?.type === "continue_prompt" || replyCandidate?.type === "trust_prompt") {
    replyCandidate = null;
  }

  let completionScore = 0;
  let blockedScore = 0;
  const ruleMatches = [];

  if (promptReturned) {
    completionScore += 30;
    ruleMatches.push("prompt_returned");
  }
  if (silenceSeconds >= settings.thresholds.silenceSeconds) {
    completionScore += 20;
    ruleMatches.push("silence_window_reached");
  }
  if (/已完成|done|finished|交付|summary|总结|created|wrote/i.test(outputSnapshot)) {
    completionScore += 25;
    ruleMatches.push("completion_keyword");
  }
  if (artifacts.length > 0) {
    completionScore += 25;
    ruleMatches.push("artifact_created");
  }
  if (matchedTargetFiles.length > 0) {
    completionScore += 35;
    ruleMatches.push("target_file_created");
  }
  if (/permission denied|access denied|requires approval|needs your approval/i.test(outputSnapshot)) {
    blockedScore += 40;
    ruleMatches.push("permission_denied");
  }
  if (/not found|missing|module not found|command not found/i.test(outputSnapshot)) {
    blockedScore += 30;
    ruleMatches.push("missing_dependency");
  }
  if (/failed|error|exception/i.test(outputSnapshot)) {
    blockedScore += 20;
    ruleMatches.push("execution_failed");
  }

  let taskState = String(meta.taskStatus || "idle");
  let verdict = "insufficient";
  let confidence = 0.4;
  let summary = "当前观察信息不足，继续等待更多输出。";
  const risks = [];
  const suggestions = [];

  if (blockedScore >= settings.thresholds.blockedScore) {
    taskState = "blocked";
    verdict = "risk";
    confidence = Math.min(0.95, blockedScore / 100);
    summary = "检测到疑似阻塞，需要人工关注。";
    risks.push("最近输出中出现权限、依赖或执行失败特征。");
    suggestions.push("建议查看终端最近输出，确认是否需要补依赖或批准操作。");
  } else if (completionScore >= settings.thresholds.completionScore) {
    taskState = "waiting_feedback";
    verdict = artifacts.length > 0 ? "pass" : "insufficient";
    confidence = Math.min(0.95, completionScore / 100);
    summary = artifacts.length > 0 ? "疑似已完成，建议人工验收。" : "疑似已完成，但尚未看到明确交付物。";
    if (artifacts.length === 0) {
      risks.push("还没有检测到 artifacts/ 下的新成果文件。");
      suggestions.push("建议确认是否需要让员工显式产出文件或摘要。");
    }
  } else if (session) {
    taskState = "working";
    verdict = "insufficient";
    confidence = 0.6;
    summary = taskSummary
      ? silenceSeconds >= settings.thresholds.silenceSeconds
        ? "员工暂时没有新输出，等待进一步结果。"
        : "员工正在执行当前任务。"
      : "员工会话运行中，等待更多输出。";
  }

  if (targetFiles.length > 0 && missingTargetFiles.length > 0) {
    risks.push(`尚未检测到目标文件：${missingTargetFiles.join("、")}`);
    suggestions.push("建议确认员工是否已按要求创建目标文件。");
    if (taskState === "waiting_feedback" && verdict === "pass") {
      verdict = "insufficient";
      summary = "疑似已完成，但目标文件仍不完整。";
    }
  }

  let autoPilotDecision = "none";
  let decisionSource = "rules";
  if (replyCandidate) {
    if (isObserverDecisionType(replyCandidate.type)) {
      suggestions.push(replyCandidate.summary);
    }
    if (replyCandidate.riskLevel === "high") {
      risks.push("检测到高风险确认提示，禁止自动驾驶直接处理。");
    }
    if (!isObserverDecisionType(replyCandidate.type)) {
      autoPilotDecision = "none";
    } else if (settings.autopilotMode === "suggest_only") {
      autoPilotDecision = "suggested";
    } else if (
      settings.autoReplyEnabled &&
      settings.allowedReplyTypes.includes(replyCandidate.type) &&
      !settings.blockedReplyTypes.includes(replyCandidate.type) &&
      (!settings.highRiskAlwaysManual || replyCandidate.riskLevel === "low")
    ) {
      autoPilotDecision =
        settings.autopilotMode === "safe_auto" && replyCandidate.riskLevel === "low"
          ? "eligible_auto"
          : settings.autopilotMode === "full_auto" && replyCandidate.riskLevel !== "high"
            ? "eligible_auto"
            : "suggested";
    } else if (replyCandidate.type) {
      autoPilotDecision = "suggested";
    }
  }

  let aiUsed = false;
  let aiError = "";
  let aiConfidence = null;
  let aiReason = "";
  let replyConfidence = null;
  const shouldUseAi =
    settings.ai.enabled &&
    (settings.inspectionMode === "ai_only" ||
      (settings.inspectionMode === "hybrid" &&
        (verdict === "insufficient" || (missingTargetFiles.length === 0 && completionScore < settings.thresholds.completionScore))));

    if (shouldUseAi) {
    try {
      const aiResult = await callInspectorAiReview(settings, {
        artifacts: artifacts.map((item) => item.title),
        completionScore,
        missingTargetFiles,
        outputSnapshot,
        replyCandidate,
        risks,
        ruleMatches,
        silenceSeconds,
        targetFiles,
        taskSummary: taskSummary || extractUserTaskFromTaskRequest(taskRequest) || "",
        verdict,
      });
      if (aiResult) {
        aiUsed = true;
        aiConfidence = aiResult.confidence;
        aiReason = aiResult.reason;
        replyConfidence = aiResult.replyConfidence;
        if (aiResult.summary) {
          summary = aiResult.summary;
        }
        if (Array.isArray(aiResult.suggestions) && aiResult.suggestions.length > 0) {
          suggestions.splice(0, suggestions.length, ...Array.from(new Set([...suggestions, ...aiResult.suggestions])));
        }
        if (Array.isArray(aiResult.risks) && aiResult.risks.length > 0) {
          risks.splice(0, risks.length, ...Array.from(new Set([...risks, ...aiResult.risks])));
        }
        if (blockedScore >= settings.thresholds.blockedScore || replyCandidate?.riskLevel === "high") {
          verdict = "risk";
        } else if (
          aiResult.verdict === "pass" &&
          missingTargetFiles.length === 0 &&
          Number(aiResult.confidence || 0) >= 0.7
        ) {
          verdict = "pass";
        } else if (aiResult.verdict === "risk" && Number(aiResult.confidence || 0) >= 0.6) {
          verdict = "risk";
        }
        if (aiResult.reason) {
          risks.push(`AI 判断依据：${aiResult.reason}`);
        }
        if (aiResult.suggestedReply && !replyCandidate?.suggestedReply && Number(aiResult.replyConfidence || 0) >= 0.75) {
          const aiSuggestedType = "ai_suggested_reply";
          const aiRiskLevel = "medium";
          suggestions.push("AI 兜底生成了一条建议回复，可先人工确认。");
          decisionSource = "rules+ai";
          if (settings.autopilotMode === "suggest_only") {
            autoPilotDecision = "suggested";
          }
          if (
            settings.autoReplyEnabled &&
            settings.allowedReplyTypes.includes(aiSuggestedType) &&
            !settings.blockedReplyTypes.includes(aiSuggestedType) &&
            settings.autopilotMode === "full_auto" &&
            !settings.highRiskAlwaysManual
          ) {
            autoPilotDecision = "eligible_auto";
          }
        }
        if (aiUsed) {
          decisionSource = "rules+ai";
        }
      }
    } catch (error) {
      aiError = error instanceof Error ? error.message : "Inspector AI 调用失败";
    }
  }

  return {
    aiError,
    aiConfidence,
    aiReason,
    aiUsed,
    autoPilotDecision,
    confidence,
    createdAt: new Date().toISOString(),
    decisionSource,
    lastAutoReplyAt,
    lastSilenceSeconds: silenceSeconds,
    replyConfidence,
    replyCandidate,
    risks,
    ruleMatches,
    summary,
    taskState,
    targetFiles,
    matchedTargetFiles,
    missingTargetFiles,
    suggestions,
    verdict,
    workspacePath: normalizedWorkspace.replace(/\\/g, "/"),
    taskSummary: taskSummary || extractUserTaskFromTaskRequest(taskRequest) || "",
  };
}

async function writeInspectorResult(workspacePath, result) {
  const targetPath = inspectorResultFilePath(workspacePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

async function runInspectorForWorkspace(workspacePath, session = null) {
  const result = await buildInspectorResult(workspacePath, session);
  if (!result) {
    return null;
  }
  const projectRoot = deriveProjectRootFromWorkspace(workspacePath);
  const inspectorSettings = (await loadInspectorSettings(projectRoot)).settings;
  const runtimeMetaPath = path.join(workspacePath, "runtime", "meta.json");
  const currentMeta = await readJsonFile(runtimeMetaPath, {});
  const replySignature = result.replyCandidate?.suggestedReply
    ? `${result.taskSummary}|${result.replyCandidate.type}|${result.replyCandidate.suggestedReply}`
    : "";

  if (session && result.replyCandidate?.suggestedReply) {
    if (result.autoPilotDecision === "eligible_auto") {
      const alreadyReplied = String(currentMeta.inspectorLastAutoReplySignature || "") === replySignature;
      if (!alreadyReplied) {
        session.pty.write(`${result.replyCandidate.suggestedReply}\r`);
        result.autoPilotDecision = "auto_replied";
        result.summary = `${result.summary} 观察者已自动回复。`.trim();
        await mergeJsonFile(runtimeMetaPath, {
          inspectorLastAutoReplyAt: new Date().toISOString(),
          inspectorLastAutoReplySignature: replySignature,
        });
        pushPromptHandlingLog({
          action: "自动回复",
          memberId: session.memberId,
          mode: `观察者 ${inspectorSettings.autopilotMode}`,
          summary: result.replyCandidate.summary || "观察者已自动回复建议选项。",
          title: "观察者自动驾驶",
          workspacePath: session.cwd.replace(/\\/g, "/"),
        });
      }
    } else if (result.autoPilotDecision === "suggested") {
      ensurePendingPrompt(session, {
        replyRiskLevel: result.replyCandidate.riskLevel,
        replyType: result.replyCandidate.type,
        replyText: result.replyCandidate.suggestedReply,
        responseMode: "approve_reject",
        summary: result.replyCandidate.summary || result.summary,
        title: "观察者建议回复",
        type: `inspector_suggestion:${result.replyCandidate.type || "generic"}`,
      });
    }
  }
  await writeInspectorResult(workspacePath, result);
  return result;
}

async function reviewInspector(payload) {
  const workspacePath = String(payload?.workspacePath || "").replace(/[\\/]+$/, "");
  if (!workspacePath) {
    throw new Error("workspacePath is required");
  }
  const memberId = String(payload?.memberId || "").trim();
  const session = memberId ? sessions.get(memberId) ?? null : null;
  const result = await runInspectorForWorkspace(workspacePath, session);
  return {
    ok: true,
    result,
  };
}

async function sendInspectorReply(payload) {
  const memberId = String(payload?.memberId || "").trim();
  const replyText = String(payload?.replyText || "").trim();
  if (!memberId) {
    throw new Error("memberId is required");
  }
  if (!replyText) {
    throw new Error("replyText is required");
  }

  const session = sessions.get(memberId);
  if (!session) {
    throw new Error("对应员工当前没有活动会话");
  }

  session.pty.write(`${replyText}\r`);
  await runInspectorForWorkspace(session.cwd, session);
  return {
    memberId,
    ok: true,
    replyText,
  };
}

function scheduleInspectorReview(memberId, delayMs = 6000) {
  const existingTimer = inspectorTimers.get(memberId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    inspectorTimers.delete(memberId);
    const session = sessions.get(memberId);
    if (!session) {
      return;
    }
    void runInspectorForWorkspace(session.cwd, session).catch(() => null);
  }, delayMs);
  inspectorTimers.set(memberId, timer);
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

function codexSessionStoragePaths() {
  const codexHome = resolveCodexHomeDir();
  return {
    archivedSessionsRoot: path.join(codexHome, "archived_sessions"),
    sessionIndexPath: path.join(codexHome, "session_index.jsonl"),
    sessionsRoot: path.join(codexHome, "sessions"),
  };
}

function normalizeComparablePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

async function readFirstLine(filePath) {
  const content = await readFile(filePath, "utf8");
  const newlineIndex = content.indexOf("\n");
  return newlineIndex >= 0 ? content.slice(0, newlineIndex) : content;
}

async function codexSessionExists(sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    return false;
  }

  try {
    const { sessionIndexPath } = codexSessionStoragePaths();
    const content = await readFile(sessionIndexPath, "utf8");
    if (content.includes(`"id":"${normalizedSessionId}"`)) {
      return true;
    }
  } catch {
    // fall through to recent session file scan
  }

  try {
    const sessionFiles = await listRecentCodexSessionFiles();
    for (const file of sessionFiles) {
      const meta = await readCodexSessionMeta(file.filePath);
      if (meta?.id === normalizedSessionId) {
        return true;
      }
    }
  } catch {
    // ignore codex session scan failures
  }

  return false;
}

async function listRecentCodexSessionFiles(limit = CODEX_SESSION_DISCOVERY_MAX_FILES) {
  const { archivedSessionsRoot, sessionsRoot } = codexSessionStoragePaths();
  const roots = [sessionsRoot, archivedSessionsRoot].filter((rootPath) => existsSync(rootPath));
  const queue = [...roots];
  const files = [];
  const minMtime = Date.now() - CODEX_SESSION_DISCOVERY_MAX_AGE_MS;

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
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      try {
        const fileStat = await stat(absolutePath);
        if (fileStat.mtimeMs < minMtime) {
          continue;
        }
        files.push({
          filePath: absolutePath,
          mtimeMs: fileStat.mtimeMs,
        });
      } catch {
        // ignore stat errors
      }
    }
  }

  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit);
}

async function readCodexSessionMeta(filePath) {
  try {
    const firstLine = await readFirstLine(filePath);
    if (!firstLine.trim()) {
      return null;
    }

    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== "session_meta" || !parsed?.payload?.id) {
      return null;
    }

    return {
      cwd: String(parsed.payload.cwd || "").replace(/\\/g, "/"),
      id: String(parsed.payload.id || "").trim(),
      timestamp:
        String(parsed.payload.timestamp || parsed.timestamp || "").trim() ||
        new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function findLatestCodexSessionForWorkspace(workspacePath, { minTimestampMs = 0 } = {}) {
  const normalizedWorkspace = normalizeComparablePath(workspacePath);
  if (!normalizedWorkspace) {
    return null;
  }

  const sessionFiles = await listRecentCodexSessionFiles();
  for (const file of sessionFiles) {
    const meta = await readCodexSessionMeta(file.filePath);
    if (!meta?.id) {
      continue;
    }
    if (normalizeComparablePath(meta.cwd) !== normalizedWorkspace) {
      continue;
    }

    const sessionTimestampMs = Date.parse(meta.timestamp || "");
    if (Number.isFinite(sessionTimestampMs) && sessionTimestampMs < minTimestampMs) {
      continue;
    }

    return meta;
  }

  return null;
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
      } else if (key === "approval_policy") {
        parsed.approvalPolicy = String(value || defaults.approvalPolicy);
      } else if (key === "sandbox_mode") {
        parsed.sandboxMode = String(value || defaults.sandboxMode);
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

    if (section === "windows") {
      if (key === "sandbox") {
        parsed.windowsSandbox = String(value || defaults.windowsSandbox);
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
    `approval_policy = "${normalized.approvalPolicy}"`,
    `sandbox_mode = "${normalized.sandboxMode}"`,
    `windows_wsl_setup_acknowledged = ${normalized.windowsWslSetupAcknowledged ? "true" : "false"}`,
    `model_context_window = ${Number(normalized.modelContextWindow) || defaultCodexConfigValues().modelContextWindow}`,
    `model_auto_compact_token_limit = ${Number(normalized.modelAutoCompactTokenLimit) || defaultCodexConfigValues().modelAutoCompactTokenLimit}`,
    "",
    "[windows]",
    `sandbox = "${normalized.windowsSandbox}"`,
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

function buildWorkspaceAgentsTemplateMarkdown() {
  return `# AGENTS.md

你正在一个 C-CLIENT 员工项目空间内工作。

本文件对当前目录及其子目录全部生效。

## 文件职责

- \`task_request.md\`
  用户直接发给你的任务原文。当前有明确任务时再处理，没有任务时保持待命。

- \`references/\`
  任务附带的参考资料目录。只有在任务提到这些文件时再读取。

- \`artifacts/\`
  真实交付物输出目录。需要沉淀结果时，把文件写到这里。

## 工作约束

- 真实产出物必须进入 \`artifacts/\`
- 不要把业务产出写进 \`runtime/meta.json\`
- 没有任务时不要自行虚构需求或生成额外流程文件
- 如果收到的是用户原文任务，直接基于任务执行，不需要补系统流程

## 交付习惯

- 优先给出简洁的任务摘要
- 需要结构化产出时再自行决定是否写计划文件
- 如果任务要求不清晰，直接在终端里说明你的理解与缺口
`;
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
      codexSessionId: String(meta.codexSessionId || "").trim(),
      projectRoot,
      promptRules: promptRules.rules,
    };
  } catch {
    const projectRoot = deriveProjectRootFromWorkspace(workspacePath);
    const promptRules = await loadPromptRules(projectRoot);
    return {
      automationSettings: defaultAutomationSettings(),
      codexSessionId: "",
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
  const projectWorkspaces = await listEmployeeProjectWorkspaces(normalizedWorkspace);
  const targetWorkspaces = projectWorkspaces.length > 0 ? projectWorkspaces : [normalizedWorkspace];
  const artifactGroups = await Promise.all(
    targetWorkspaces.map(async (projectWorkspace) =>
      (await listArtifactEntries(projectWorkspace)).map((entry) => ({
        ...entry,
        projectName: deriveProjectNameFromWorkspace(projectWorkspace),
        workspacePath: projectWorkspace.replace(/\\/g, "/"),
      })),
    ),
  );

  return {
    artifacts:
      (indexedEntries.length > 0 ? indexedEntries : artifactGroups.flat().slice(0, 100)),
    finished: [],
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
  const [projectWorkspaces, projectsIndex] = await Promise.all([
    listEmployeeProjectWorkspaces(normalizedWorkspace),
    readProjectsIndex(employeeRoot),
  ]);

  const itemsByWorkspace = new Map(
    (Array.isArray(projectsIndex.items) ? projectsIndex.items : []).map((item) => [
      String(item?.workspacePath || "").replace(/\\/g, "/").toLowerCase(),
      item,
    ]),
  );
  const entries = await Promise.all(
    projectWorkspaces.map(async (projectWorkspace) => {
      const normalizedProjectWorkspace = projectWorkspace.replace(/\\/g, "/");
      const meta = await readJsonFile(path.join(projectWorkspace, "runtime", "meta.json"), {});
      const projectItem = itemsByWorkspace.get(normalizedProjectWorkspace.toLowerCase()) ?? {};
      const taskState = buildProjectTaskState({
        ...projectItem,
        ...meta,
      });
      const isCurrent = projectsIndex.currentProject === deriveProjectNameFromWorkspace(projectWorkspace);
      const statusMap = {
        assigned: "待启动",
        blocked: "阻塞",
        done: "已完成",
        idle: "空闲",
        queued: "排队中",
        working: "执行中",
      };

      return {
        currentTask: taskState.currentTask,
        isCurrent,
        nextAction: taskState.nextAction,
        projectName: deriveProjectNameFromWorkspace(projectWorkspace),
        queued: taskState.taskStatus === "queued",
        status: statusMap[taskState.taskStatus] ?? "空闲",
        updatedAt:
          projectItem.lastActiveAt ??
          meta.lastTaskCompletedAt ??
          meta.lastTaskAssignedAt ??
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
  const [employeeProfile, projectsIndex] = await Promise.all([
    readJsonFile(files.employeeProfilePath, {}),
    readProjectsIndex(employeeRoot),
  ]);

  const currentProjectItem = (Array.isArray(projectsIndex.items) ? projectsIndex.items : []).find(
    (item) => item?.projectName === projectsIndex.currentProject,
  );
  const currentWorkspace =
    String(currentProjectItem?.workspacePath || "").replace(/[\\/]+$/, "") || normalizedWorkspace;
  const currentMeta = await readJsonFile(path.join(currentWorkspace, "runtime", "meta.json"), {});
  const currentTaskState = buildProjectTaskState({
    ...(currentProjectItem ?? {}),
    ...currentMeta,
  });
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
      currentProjectItem?.projectName || deriveProjectNameFromWorkspace(currentWorkspace),
    currentTaskState,
    currentWorkspace: currentWorkspace.replace(/\\/g, "/"),
    dispatchItems: (Array.isArray(projectsIndex.items) ? projectsIndex.items : []).filter(
      (item) => item?.taskStatus === "queued",
    ),
    employeeProfile,
    employeeRoot: employeeRoot.replace(/\\/g, "/"),
    liveSession,
    memberId,
    projectsIndex,
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
  const inspector = await ensureInspectorResult(context.currentWorkspace, context.liveSession);
  return {
    status: {
      currentProject: context.currentProjectName,
      currentTask: context.currentTaskState.currentTask,
      inspector,
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
  const artifactEntries = await listArtifactEntries(normalizedWorkspace);
  const archiveItems = [];

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

function buildRawTaskLaunchPrompt(taskDescription, savedReferences) {
  const normalizedTask = String(taskDescription || "").trim();
  const referencePaths = Array.isArray(savedReferences)
    ? savedReferences
        .map((reference) => String(reference?.absolutePath || "").trim())
        .filter(Boolean)
    : [];

  if (!normalizedTask && referencePaths.length === 0) {
    return "";
  }

  if (referencePaths.length === 0) {
    return normalizedTask;
  }

  return `${normalizedTask}\n\n参考文件路径：\n${referencePaths.map((value) => `- ${value}`).join("\n")}`.trim();
}

function extractUserTaskFromTaskRequest(content) {
  const normalized = String(content || "").trim();
  if (!normalized) {
    return "";
  }
  const marker = "\n## 用户任务\n";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + marker.length).trim();
  }
  return normalized.replace(/^# .+\n+/m, "").trim();
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

  const taskRequestPath = path.join(workspacePath, "task_request.md");
  const runtimeMetaPath = path.join(workspacePath, "runtime", "meta.json");
  const employeeRoot = deriveEmployeeRootFromWorkspace(workspacePath);
  const assignMode = payload.assignMode === "queued" ? "queued" : "current";

  await writeFile(
    taskRequestPath,
    `# 任务原文\n\n- 发布时间：${assignedAt}\n- 优先级：${priority}\n- 时间窗口：${timeWindow}\n- 截止时间：${deadlineAt || "未设置"}\n- 来源：${source}${savedReferences.length > 0 ? `\n- 参考资料数：${savedReferences.length}` : ""}\n\n## 用户任务\n\n${taskDescription}${referenceSection ? `\n\n${referenceSection}` : ""}\n`,
    "utf8",
  );

  await mergeJsonFile(runtimeMetaPath, {
    lastAction: "assign_task",
    lastTaskAssignedAt: assignedAt,
    lastTaskDeadline: deadlineAt || null,
    lastTaskPriority: priority,
    lastTaskSource: source,
    lastTaskSummary: taskSummary,
    lastTaskTimeWindow: timeWindow,
    pendingLaunchPrompt: buildRawTaskLaunchPrompt(taskDescription, savedReferences),
    lastAssignedReferences: savedReferences.map((reference) => ({
      absolutePath: reference.absolutePath,
      isImage: reference.isImage,
      mimeType: reference.mimeType,
      name: reference.name,
      relativePath: reference.relativePath,
      size: reference.size,
    })),
    taskStatus: assignMode === "current" ? "assigned" : "queued",
    workStatus: assignMode === "current" ? "busy" : "idle",
  });

  await upsertProjectIndexEntry(employeeRoot, workspacePath, {
    lastActiveAt: assignedAt,
    lastTaskAssignedAt: assignedAt,
    lastTaskSummary: taskSummary,
    projectName: deriveProjectNameFromWorkspace(workspacePath),
    taskStatus: assignMode === "current" ? "assigned" : "queued",
  });

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
  const currentMeta = await readJsonFile(path.join(currentWorkspacePath, "runtime", "meta.json"), {});
  const canSwitchNow = buildProjectTaskState(currentMeta).taskStatus !== "working";
  const targetWorkspacePath = sameProject
    ? currentWorkspacePath
    : await ensureProjectWorkspaceForAssignment(currentWorkspacePath, requestedProjectName);

  const assignResult = await assignTaskWithinWorkspace({
    ...payload,
    assignMode: sameProject || canSwitchNow ? "current" : "queued",
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

async function completeCurrentTask(payload) {
  const workspacePath = String(payload.workspacePath || "").replace(/[\\/]+$/, "");
  if (!workspacePath) {
    throw new Error("workspacePath is required");
  }

  const employeeRoot = deriveEmployeeRootFromWorkspace(workspacePath);
  const currentProjectName = deriveProjectNameFromWorkspace(workspacePath);
  const taskRequestPath = path.join(workspacePath, "task_request.md");
  const runtimeMetaPath = path.join(workspacePath, "runtime", "meta.json");
  const artifactsDir = path.join(workspacePath, "artifacts");
  const runtimeMeta = await readJsonFile(runtimeMetaPath, {});
  const currentTask = {
    deadlineAt: runtimeMeta.lastTaskDeadline ?? "",
    priority: runtimeMeta.lastTaskPriority ?? "P1",
    source: runtimeMeta.lastTaskSource ?? "手动发布",
    summary: String(runtimeMeta.lastTaskSummary || "").trim(),
    timeWindow: runtimeMeta.lastTaskTimeWindow ?? "3 小时内",
  };

  if (!currentTask.summary || currentTask.summary === "暂无") {
    throw new Error("当前没有可完成的任务");
  }

  const completedAt = new Date().toISOString();
  const artifactFileName = `completion_${completedAt.replace(/[:.]/g, "-")}.md`;
  const artifactPath = path.join(artifactsDir, artifactFileName);

  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    artifactPath,
    `# 任务完成摘要\n\n- 任务：${currentTask.summary}\n- 完成时间：${completedAt}\n- 优先级：${currentTask.priority || "P1"}\n- 时间窗口：${currentTask.timeWindow || "3 小时内"}\n- 截止时间：${currentTask.deadlineAt || "未设置"}\n- 指派来源：${currentTask.source || "手动发布"}\n\n## 完成说明\n\n- 由客户端执行归档动作生成\n- 可继续补充真实交付物或替换为正式产出文件\n`,
    "utf8",
  );
  await appendDeliveryIndex(employeeRoot, {
    completedAt,
    filePath: artifactPath,
    projectName: currentProjectName,
    title: currentTask.summary,
    workspacePath,
  });

  let switchWorkspacePath = null;
  let switchProjectName = null;
  await mergeJsonFile(runtimeMetaPath, {
    lastAction: "complete_task",
    lastCompletedAt: completedAt,
    lastCompletedTask: currentTask.summary,
    pendingLaunchPrompt: null,
    taskStatus: "idle",
    workStatus: "idle",
  });
  await upsertProjectIndexEntry(employeeRoot, workspacePath, {
    lastActiveAt: completedAt,
    lastTaskCompletedAt: completedAt,
    lastTaskSummary: currentTask.summary,
    taskStatus: "done",
  });

  const nextProjectDispatch = await popNextEmployeeProjectDispatch(employeeRoot);
  if (nextProjectDispatch?.workspacePath) {
    switchWorkspacePath = String(nextProjectDispatch.workspacePath).replace(/\\/g, "/");
    switchProjectName = nextProjectDispatch.projectName ?? deriveProjectNameFromWorkspace(switchWorkspacePath);
    await updateCurrentProjectPointer(employeeRoot, switchWorkspacePath);
    const nextTaskRequest = await readOptionalTextFile(path.join(switchWorkspacePath, "task_request.md"));
    const nextMetaPath = path.join(switchWorkspacePath, "runtime", "meta.json");
    await mergeJsonFile(nextMetaPath, {
      pendingLaunchPrompt: extractUserTaskFromTaskRequest(nextTaskRequest) || null,
      taskStatus: "assigned",
      workStatus: "busy",
    });
    await upsertProjectIndexEntry(employeeRoot, switchWorkspacePath, {
      lastActiveAt: completedAt,
      taskStatus: "assigned",
    });
  }

  await rm(taskRequestPath, { force: true });
  await runInspectorForWorkspace(workspacePath, sessions.get(runtimeMeta.memberId) ?? null);

  return {
    artifactFileName,
    completed: true,
    completedAt,
    completedTask: currentTask.summary,
    hasNextTask: Boolean(nextProjectDispatch),
    nextTask: nextProjectDispatch?.lastTaskSummary ?? null,
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
  const normalizedPath = path.resolve(filePath);
  const previous = jsonMergeQueues.get(normalizedPath) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      let current = {};
      try {
        current = JSON.parse(await readFile(normalizedPath, "utf8"));
      } catch {
        current = {};
      }
      await writeFile(normalizedPath, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
    });
  jsonMergeQueues.set(normalizedPath, next);
  try {
    await next;
  } finally {
    if (jsonMergeQueues.get(normalizedPath) === next) {
      jsonMergeQueues.delete(normalizedPath);
    }
  }
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

async function syncWorkspaceAgentsFile(workspacePath, employeeRoot, enabled = true) {
  const employeeFiles = employeeRootFiles(employeeRoot);
  const { agentsPath } = workspaceInstructionPaths(workspacePath);
  const templateContent = await readOptionalTextFile(employeeFiles.employeeAgentPath);

  if (!enabled) {
    await rm(agentsPath, { force: true });
    return {
      activeAgentPath: "",
      employeeAgentPath: employeeFiles.employeeAgentPath.replace(/\\/g, "/"),
      enabled: false,
      status: "disabled",
    };
  }

  if (!String(templateContent || "").trim()) {
    await rm(agentsPath, { force: true });
    return {
      activeAgentPath: "",
      employeeAgentPath: employeeFiles.employeeAgentPath.replace(/\\/g, "/"),
      enabled: true,
      status: "missing_template",
    };
  }

  await writeFile(
    agentsPath,
    `${normalizeMarkdownContent(templateContent, "# AGENTS.md\n")}\n`,
    "utf8",
  );

  return {
    activeAgentPath: agentsPath.replace(/\\/g, "/"),
    employeeAgentPath: employeeFiles.employeeAgentPath.replace(/\\/g, "/"),
    enabled: true,
    status: "synced",
  };
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
      const projectsIndex = await readProjectsIndex(employeeRoot);
      const projectName = meta.projectName || deriveProjectNameFromWorkspace(workspacePath);
      if (projectsIndex.currentProject && projectsIndex.currentProject !== projectName) {
        continue;
      }
      const projectItem = (Array.isArray(projectsIndex.items) ? projectsIndex.items : []).find(
        (item) => item?.projectName === projectName,
      ) ?? {};
      const normalizedWorkspace = String(workspacePath).replace(/\\/g, "/").toLowerCase();
      const liveSession =
        (meta.memberId && sessions.has(meta.memberId) ? sessions.get(meta.memberId) : null) ??
        Array.from(sessions.values()).find(
          (session) => String(session.cwd).replace(/\\/g, "/").toLowerCase() === normalizedWorkspace,
        ) ??
        null;
      const [latestArtifact, indexedEntries, inspector] = await Promise.all([
        findLatestArtifact(workspacePath),
        listEmployeeDeliveryEntries(workspacePath),
        ensureInspectorResult(workspacePath, liveSession),
      ]);
      const currentTaskState = buildProjectTaskState({
        ...projectItem,
        ...meta,
      });
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
      const latestIndexedDelivery = indexedEntries[0] ?? null;

      runtimes.push({
        company: meta.company ?? deriveCompanyFromWorkspace(normalizedRoot, workspacePath),
        codexSessionId: meta.codexSessionId ?? null,
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
        recentCompleted: latestIndexedDelivery?.title ?? null,
        role: meta.role ?? "实现执行",
        autoTrustWorkspace: meta.autoTrustWorkspace !== false,
        elevationMode: meta.elevationMode ?? "manual",
        taskDeadline: meta.lastTaskDeadline ?? meta.lastAssignedDeadline ?? null,
        taskIntakeStatus: "none",
        taskPriority: meta.lastTaskPriority ?? meta.lastAssignedPriority ?? null,
        promptAutomation: meta.promptAutomation ?? "safe_auto",
        taskSource: meta.lastTaskSource ?? meta.lastAssignedSource ?? null,
        taskTimeWindow: meta.lastTaskTimeWindow ?? meta.lastAssignedTimeWindow ?? null,
        nextAction: currentTaskState.nextAction,
        runtimeStatus,
        sessionId: activeSessionId,
        shell: meta.shell ?? "",
        startedAt: liveSession?.startedAt ?? meta.startedAt ?? "",
        status: liveSession ? "running" : persistedStatus,
        stoppedAt: meta.stoppedAt ?? null,
        taskQueue: (Array.isArray(projectsIndex.items) ? projectsIndex.items : [])
          .filter((item) => item?.taskStatus === "queued")
          .map((item) => String(item?.lastTaskSummary || item?.projectName || "").trim())
          .filter(Boolean),
        inspector,
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
  const runtimeDir = path.join(workspacePath, "runtime");
  const createdAt = new Date().toISOString();
  const employeeRoot = path.dirname(workspacePath);

  await mkdir(workspacePath, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

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
    path.join(runtimeDir, "meta.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
  );

  await ensureEmployeeRootMetadata({
    agentDefinitionText: payload.agentDefinitionText,
    company,
    department,
    employeeCode: payload.employeeCode ?? "",
    employeeName,
    employeeRoot,
    memberId: payload.memberId ?? "",
    permission: payload.permission ?? "",
    projectName,
    projectWorkspacePath: workspacePath,
    repoSource: payload.repoSource ?? "",
    role: payload.role ?? "",
    shell: payload.shell ?? "",
    systemAgentEnabled: payload.systemAgentEnabled !== false,
  });
  await syncWorkspaceAgentsFile(workspacePath, employeeRoot, payload.systemAgentEnabled !== false);

  const files = ["runtime/meta.json"];
  if (payload.systemAgentEnabled !== false) {
    files.unshift("AGENTS.md");
  }

  return {
    created: true,
    files,
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
    deliveriesIndexPath: path.join(employeeRoot, "deliveries-index.json"),
    employeeAgentPath: path.join(employeeRoot, "EMPLOYEE_AGENT.md"),
    employeeProfilePath: path.join(employeeRoot, "employee.json"),
    projectsIndexPath: path.join(employeeRoot, "projects.json"),
  };
}

async function readProjectsIndex(employeeRoot) {
  const files = employeeRootFiles(employeeRoot);
  const fallback = {
    currentProject: "",
    items: [],
    updatedAt: null,
  };
  const current = await readJsonFile(files.projectsIndexPath, fallback);
  return {
    currentProject: String(current?.currentProject || ""),
    items: Array.isArray(current?.items) ? current.items : [],
    updatedAt: current?.updatedAt ?? null,
  };
}

async function writeProjectsIndex(employeeRoot, value) {
  const files = employeeRootFiles(employeeRoot);
  await writeJsonFile(files.projectsIndexPath, {
    currentProject: String(value?.currentProject || ""),
    items: Array.isArray(value?.items) ? value.items : [],
    updatedAt: value?.updatedAt ?? new Date().toISOString(),
  });
}

function buildProjectTaskState(meta = {}) {
  const taskStatus = ["idle", "assigned", "queued", "working", "blocked", "done"].includes(meta.taskStatus)
    ? meta.taskStatus
    : "idle";
  const currentTask =
    taskStatus === "idle" || taskStatus === "done"
      ? "暂无"
      : String(meta.lastTaskSummary || "").trim() || "暂无";
  const nextAction =
    taskStatus === "assigned"
      ? "等待启动"
      : taskStatus === "queued"
        ? "等待切换项目"
        : taskStatus === "working"
          ? "执行中"
          : taskStatus === "blocked"
            ? "等待处理阻塞"
            : "暂无";

  return {
    currentTask,
    nextAction,
    taskStatus,
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
  systemAgentEnabled,
}) {
  const files = employeeRootFiles(employeeRoot);
  const normalizedEmployeeRoot = employeeRoot.replace(/\\/g, "/");

  await ensureTextFile(
    files.employeeAgentPath,
    normalizeMarkdownContent(agentDefinitionText, "# EMPLOYEE_AGENT.md\n\n待补充\n"),
  );

  await ensureTextFile(
    files.employeeProfilePath,
    `${JSON.stringify(
      {
        company,
        createdAt: new Date().toISOString(),
        department,
        employeeCode,
        employeeAgentPath: files.employeeAgentPath.replace(/\\/g, "/"),
        employeeName,
        memberId,
        permission,
        repoSource,
        role,
        shell,
        systemAgentEnabled: systemAgentEnabled !== false,
        employeeRoot: normalizedEmployeeRoot,
      },
      null,
      2,
    )}\n`,
  );

  await ensureTextFile(
    files.projectsIndexPath,
    `${JSON.stringify(
      {
        currentProject: projectName,
        items: [
          {
            lastActiveAt: new Date().toISOString(),
            lastOpenedAt: new Date().toISOString(),
            lastTaskAssignedAt: null,
            lastTaskCompletedAt: null,
            lastTaskSummary: "",
            projectName,
            taskStatus: "idle",
            workspacePath: projectWorkspacePath.replace(/\\/g, "/"),
          },
        ],
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
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
  const current = await readProjectsIndex(employeeRoot);
  const projectName = deriveProjectNameFromWorkspace(workspacePath);
  const normalizedWorkspace = workspacePath.replace(/\\/g, "/");
  const now = new Date().toISOString();
  const existingItems = Array.isArray(current.items) ? current.items : [];
  const hasItem = existingItems.some(
    (item) => String(item?.workspacePath || "").replace(/\\/g, "/").toLowerCase() === normalizedWorkspace.toLowerCase(),
  );
  const items = hasItem
    ? existingItems.map((item) =>
        String(item?.workspacePath || "").replace(/\\/g, "/").toLowerCase() === normalizedWorkspace.toLowerCase()
          ? {
              ...item,
              lastOpenedAt: now,
              projectName,
              workspacePath: normalizedWorkspace,
            }
          : item,
      )
    : [
        ...existingItems,
        {
          lastActiveAt: now,
          lastOpenedAt: now,
          lastTaskAssignedAt: null,
          lastTaskCompletedAt: null,
          lastTaskSummary: "",
          projectName,
          taskStatus: "idle",
          workspacePath: normalizedWorkspace,
        },
      ];

  await writeProjectsIndex(employeeRoot, {
    currentProject: projectName,
    items,
    updatedAt: now,
  });
}

async function enqueueEmployeeProjectDispatch(employeeRoot, entry) {
  const current = await readProjectsIndex(employeeRoot);
  const normalizedWorkspace = entry.workspacePath.replace(/\\/g, "/");
  const now = new Date().toISOString();
  const items = Array.isArray(current.items) ? current.items : [];
  const nextItems = items.some(
    (item) => String(item?.workspacePath || "").replace(/\\/g, "/").toLowerCase() === normalizedWorkspace.toLowerCase(),
  )
    ? items.map((item) =>
        String(item?.workspacePath || "").replace(/\\/g, "/").toLowerCase() === normalizedWorkspace.toLowerCase()
          ? {
              ...item,
              lastActiveAt: now,
              lastTaskAssignedAt: entry.createdAt ?? now,
              lastTaskSummary: entry.taskSummary,
              projectName: entry.projectName,
              taskStatus: "queued",
              workspacePath: normalizedWorkspace,
            }
          : item,
      )
    : [
        ...items,
        {
          lastActiveAt: now,
          lastOpenedAt: null,
          lastTaskAssignedAt: entry.createdAt ?? now,
          lastTaskCompletedAt: null,
          lastTaskSummary: entry.taskSummary,
          projectName: entry.projectName,
          taskStatus: "queued",
          workspacePath: normalizedWorkspace,
        },
      ];

  const next = {
    currentProject: current.currentProject,
    items: nextItems,
    updatedAt: now,
  };
  await writeProjectsIndex(employeeRoot, next);
  return next;
}

async function popNextEmployeeProjectDispatch(employeeRoot) {
  const current = await readProjectsIndex(employeeRoot);
  const items = Array.isArray(current.items) ? current.items : [];
  const queuedItems = items
    .filter((item) => item?.taskStatus === "queued" && item?.workspacePath)
    .sort((left, right) => String(left?.lastTaskAssignedAt || "").localeCompare(String(right?.lastTaskAssignedAt || "")));
  const nextItem = queuedItems[0];
  if (!nextItem) {
    return null;
  }
  await writeProjectsIndex(employeeRoot, {
    currentProject: current.currentProject,
    items: items.map((item) =>
      String(item?.workspacePath || "").replace(/\\/g, "/").toLowerCase() ===
      String(nextItem.workspacePath || "").replace(/\\/g, "/").toLowerCase()
        ? {
            ...item,
            taskStatus: "assigned",
          }
        : item,
    ),
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

async function upsertProjectIndexEntry(employeeRoot, workspacePath, patch = {}) {
  const current = await readProjectsIndex(employeeRoot);
  const normalizedWorkspace = workspacePath.replace(/\\/g, "/");
  const projectName = patch.projectName ?? deriveProjectNameFromWorkspace(workspacePath);
  const now = new Date().toISOString();
  const items = Array.isArray(current.items) ? current.items : [];
  const hasItem = items.some(
    (item) => String(item?.workspacePath || "").replace(/\\/g, "/").toLowerCase() === normalizedWorkspace.toLowerCase(),
  );
  const nextItems = hasItem
    ? items.map((item) =>
        String(item?.workspacePath || "").replace(/\\/g, "/").toLowerCase() === normalizedWorkspace.toLowerCase()
          ? {
              ...item,
              ...patch,
              projectName,
              workspacePath: normalizedWorkspace,
            }
          : item,
      )
    : [
        ...items,
        {
          lastActiveAt: now,
          lastOpenedAt: null,
          lastTaskAssignedAt: null,
          lastTaskCompletedAt: null,
          lastTaskSummary: "",
          projectName,
          taskStatus: "idle",
          workspacePath: normalizedWorkspace,
          ...patch,
        },
      ];

  const next = {
    currentProject: current.currentProject,
    items: nextItems,
    updatedAt: now,
  };
  await writeProjectsIndex(employeeRoot, next);
  return next;
}

async function ensureProjectWorkspaceForAssignment(currentWorkspacePath, projectName) {
  const currentMetaPath = path.join(currentWorkspacePath, "runtime", "meta.json");
  const currentMeta = await readJsonFile(currentMetaPath, {});
  const employeeRoot = deriveEmployeeRootFromWorkspace(currentWorkspacePath);
  const files = employeeRootFiles(employeeRoot);
  const employeeProfile = await readJsonFile(files.employeeProfilePath, currentMeta);

  const result = await initializeWorkspace({
    agentDefinitionText: await readOptionalTextFile(files.employeeAgentPath),
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
    systemAgentEnabled: employeeProfile.systemAgentEnabled !== false,
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

function buildCodexPermissionArgs(permission) {
  if (permission === "完全权限") {
    return ["-a", "never", "-s", "danger-full-access"];
  }

  return ["-a", "never", "-s", "workspace-write"];
}

async function resolveRuntimeLaunch({ cwd, permission, shell }) {
  const resolvedShell = await resolveShell(shell);
  const resolvedCwd = resolveCwd(cwd);
  const projectRoot = deriveProjectRootFromWorkspace(resolvedCwd);
  const employeeRoot = deriveEmployeeRootFromWorkspace(resolvedCwd);
  await ensureWorkspaceAgentsFile(projectRoot, resolvedCwd);
  const employeeProfile = await readJsonFile(employeeRootFiles(employeeRoot).employeeProfilePath, {});
  const agentSyncState = await syncWorkspaceAgentsFile(
    resolvedCwd,
    employeeRoot,
    employeeProfile.systemAgentEnabled !== false,
  );

  const runtimeMeta = await readJsonFile(path.join(resolvedCwd, "runtime", "meta.json"), {});
  await mergeJsonFile(path.join(resolvedCwd, "runtime", "meta.json"), {
    activeAgentPath: agentSyncState.activeAgentPath,
    employeeAgentPath: agentSyncState.employeeAgentPath,
    systemAgentEnabled: agentSyncState.enabled,
    systemAgentStatus: agentSyncState.status,
  });
  const codexAvailable = await commandExists("codex");
  const storedCodexSessionId = String(runtimeMeta?.codexSessionId || "").trim();
  const canResumeCodexSession =
    Boolean(storedCodexSessionId) && (await codexSessionExists(storedCodexSessionId));
  const pendingLaunchPrompt = String(runtimeMeta?.pendingLaunchPrompt || "").trim();

  if (codexAvailable) {
    if (process.platform === "win32") {
      const wrapperShell = await resolveCodexWrapperShell(resolvedShell);
      const quotedCwd = escapePowerShellSingleQuoted(resolvedCwd);
      const permissionArgs = buildCodexPermissionArgs(permission)
        .map((value) => `'${escapePowerShellSingleQuoted(value)}'`)
        .join(", ");
      const quotedLaunchPrompt = escapePowerShellSingleQuoted(pendingLaunchPrompt);
      const launchPromptArg = pendingLaunchPrompt ? `, '${quotedLaunchPrompt}'` : "";

      if (canResumeCodexSession) {
        const quotedCodexSessionId = escapePowerShellSingleQuoted(storedCodexSessionId);
        return {
          args: [
            "-NoLogo",
            "-NoExit",
            "-Command",
            `$codexArgs = @('resume', '--no-alt-screen', '-C', '${quotedCwd}', ${permissionArgs}, '${quotedCodexSessionId}'${launchPromptArg}); & codex @codexArgs`,
          ],
          command: wrapperShell,
          consumePendingLaunchPrompt: Boolean(pendingLaunchPrompt),
          cwd: resolvedCwd,
          launchMode: "codex",
          resolvedShell: "codex",
          resumeUsed: true,
          storedCodexSessionId,
        };
      }

      return {
        args: [
          "-NoLogo",
          "-NoExit",
          "-Command",
          `$codexArgs = @('--no-alt-screen', '-C', '${quotedCwd}', ${permissionArgs}${launchPromptArg}); & codex @codexArgs`,
        ],
        command: wrapperShell,
        consumePendingLaunchPrompt: Boolean(pendingLaunchPrompt),
        cwd: resolvedCwd,
        launchMode: "codex",
        resolvedShell: "codex",
        resumeUsed: false,
        storedCodexSessionId,
      };
    }

    if (canResumeCodexSession) {
      return {
        args: [
          "resume",
          "--no-alt-screen",
          "-C",
          resolvedCwd,
          ...buildCodexPermissionArgs(permission),
          storedCodexSessionId,
          ...(pendingLaunchPrompt ? [pendingLaunchPrompt] : []),
        ],
        command: "codex",
        consumePendingLaunchPrompt: Boolean(pendingLaunchPrompt),
        cwd: resolvedCwd,
        launchMode: "codex",
        resolvedShell: "codex",
        resumeUsed: true,
        storedCodexSessionId,
      };
    }

      return {
        args: [
          "--no-alt-screen",
          "-C",
          resolvedCwd,
          ...buildCodexPermissionArgs(permission),
          ...(pendingLaunchPrompt ? [pendingLaunchPrompt] : []),
        ],
        command: "codex",
        consumePendingLaunchPrompt: Boolean(pendingLaunchPrompt),
        cwd: resolvedCwd,
        launchMode: "codex",
        resolvedShell: "codex",
        resumeUsed: false,
        storedCodexSessionId,
      };
  }

  return {
    args: [],
    command: resolvedShell,
    consumePendingLaunchPrompt: false,
    cwd: resolvedCwd,
    launchMode: "shell",
    resolvedShell,
    resumeUsed: false,
    storedCodexSessionId,
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
    replyRiskLevel: prompt.replyRiskLevel ? String(prompt.replyRiskLevel) : "",
    replyType: prompt.replyType ? String(prompt.replyType) : "",
    replyText: prompt.replyText ? String(prompt.replyText) : "",
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

function startCodexSessionDiscovery(session) {
  if (session.launchMode !== "codex") {
    return () => {};
  }

  const minTimestampMs = Math.max(
    0,
    (Date.parse(String(session.startedAt || "")) || Date.now()) - 1000 * 60 * 2,
  );
  let cancelled = false;
  const runtimeMetaPath = path.join(session.cwd, "runtime", "meta.json");

  const tick = async (attempt = 0) => {
    if (cancelled) {
      return;
    }
    const liveSession = sessions.get(session.memberId);
    if (!liveSession || liveSession !== session) {
      return;
    }

    try {
      const discovered = await findLatestCodexSessionForWorkspace(session.cwd, {
        minTimestampMs,
      });
      if (discovered?.id) {
        session.codexSessionId = discovered.id;
        await mergeJsonFile(runtimeMetaPath, {
          codexSessionId: discovered.id,
          lastCodexSessionLookupAt: new Date().toISOString(),
        });
        return;
      }
    } catch {
      // ignore codex session discovery failures
    }

    if (attempt + 1 >= CODEX_SESSION_DISCOVERY_MAX_ATTEMPTS) {
      return;
    }

    setTimeout(() => {
      void tick(attempt + 1);
    }, CODEX_SESSION_DISCOVERY_POLL_INTERVAL_MS).unref?.();
  };

  void tick();
  return () => {
    cancelled = true;
  };
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

  try {
    session.stopCodexSessionDiscovery?.();
  } catch {
    // ignore timer cleanup errors
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
      codexResumeUsed: session.codexResumeUsed,
      codexSessionId: session.codexSessionId || null,
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
    codexResumeUsed: session.codexResumeUsed,
    codexSessionId: session.codexSessionId || null,
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
  } else if (String(prompt.type || "").startsWith("inspector_suggestion:")) {
    if (action === "approve") {
      command = `${String(prompt.replyText || "").trim()}\r`;
    } else if (action === "reject" || action === "dismiss") {
      pendingPrompts.delete(promptId);
      pushPromptHandlingLog({
        action: action === "dismiss" ? "忽略" : "拒绝",
        memberId: prompt.memberId,
        mode: "观察者建议",
        summary: prompt.summary,
        title: prompt.title,
        workspacePath: prompt.workspacePath,
      });
      return { action, ok: true, promptId };
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
    codexResumeUsed: Boolean(launchTarget.resumeUsed),
    codexSessionId:
      String(launchTarget.storedCodexSessionId || "").trim() ||
      String(runtimeConfiguration.codexSessionId || "").trim(),
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
    stopCodexSessionDiscovery: () => {},
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
    scheduleInspectorReview(memberId);
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    const meta = `\r\n[bridge] session exited (code=${exitCode}, signal=${signal ?? "none"})\r\n`;
    pushHistory(session, createHistoryItem("meta", meta));
    broadcast(session, { type: "output", data: meta, memberId });
    broadcast(session, { type: "exit", exitCode, signal, memberId });
    try {
      session.stopCodexSessionDiscovery?.();
    } catch {
      // ignore timer cleanup errors
    }
    const inspectorTimer = inspectorTimers.get(memberId);
    if (inspectorTimer) {
      clearTimeout(inspectorTimer);
      inspectorTimers.delete(memberId);
    }
    sessions.delete(memberId);
  });

  sessions.set(memberId, session);
  session.stopCodexSessionDiscovery = startCodexSessionDiscovery(session);

  if (launchTarget.consumePendingLaunchPrompt) {
    await mergeJsonFile(path.join(launchTarget.cwd, "runtime", "meta.json"), {
      pendingLaunchPrompt: null,
    });
  }

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

  if (request.method === "POST" && url.pathname === "/api/inspector/review") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await reviewInspector(payload);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "inspector review failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/inspector/reply") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await sendInspectorReply(payload);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "inspector reply failed",
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
          const runtimeMetaPath = path.join(payload.cwd, "runtime", "meta.json");
          const currentMeta = await readJsonFile(runtimeMetaPath, {});
          const nextTaskStatus = String(currentMeta?.lastTaskSummary || "").trim() ? "working" : "idle";
          await mergeJsonFile(runtimeMetaPath, {
            codexResumeUsed: session.codexResumeUsed,
            codexSessionId: session.codexSessionId || null,
            lastAction: "start",
            lastActiveAt: session.startedAt,
            launchMode: session.launchMode,
            memberId,
            pid: session.pid,
            resolvedShell: session.shell,
            sessionId: session.id,
            startedAt: session.startedAt,
            status: "running",
            stoppedAt: null,
            taskStatus: nextTaskStatus,
          });
          await upsertProjectIndexEntry(deriveEmployeeRootFromWorkspace(payload.cwd), payload.cwd, {
            lastActiveAt: session.startedAt,
            lastOpenedAt: session.startedAt,
            taskStatus: nextTaskStatus,
          });
          await runInspectorForWorkspace(payload.cwd, session);
        }

        writeJson(response, 200, {
          cwd: session.cwd,
          codexResumeUsed: session.codexResumeUsed,
          codexSessionId: session.codexSessionId || null,
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

  if (request.method === "POST" && url.pathname === "/api/settings/inspector/load") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await loadInspectorSettings(payload.projectRoot);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "inspector settings load failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/settings/inspector/save") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await saveInspectorSettings(payload.projectRoot, payload.settings);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "inspector settings save failed",
        });
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/settings/inspector/test") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        await ensureAuthorizedRequest(request, payload, url);
        const result = await testInspectorSettings(payload);
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "inspector settings test failed",
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

setInterval(() => {
  for (const session of sessions.values()) {
    void runInspectorForWorkspace(session.cwd, session).catch(() => null);
  }
}, 20000).unref?.();

server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
  console.log(
    `[c-client bridge] listening on http://${BRIDGE_HOST}:${BRIDGE_PORT} (ws /terminal)`,
  );
});
