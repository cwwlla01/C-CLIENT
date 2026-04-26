import type { Node } from "@xyflow/react";

export type RuntimeStatus = "running" | "stopped" | "error";
export type WorkStatus = "idle" | "busy" | "blocked";
export type TaskIntakeStatus = "none" | "pending_ack" | "confirming" | "confirm_failed" | "acknowledged" | "planned";
export type AgentStatus = "matched" | "mismatched" | "unverified";
export type PromptAutomationMode = "manual" | "safe_auto";
export type ElevationMode = "manual" | "auto_if_full_access";

export type RuntimeAutomationSettings = {
  autoTrustWorkspace: boolean;
  elevationMode: ElevationMode;
  promptAutomation: PromptAutomationMode;
};

export type RuntimeMember = {
  inspector?: {
    aiConfidence?: number | null;
    aiError?: string;
    aiReason?: string;
    aiUsed?: boolean;
    autoPilotDecision?: string;
    confidence?: number;
    createdAt?: string;
    decisionSource?: string;
    lastAutoReplyAt?: string | null;
    lastSilenceSeconds?: number;
    matchedTargetFiles?: string[];
    missingTargetFiles?: string[];
    replyConfidence?: number | null;
    replyCandidate?: {
      riskLevel?: string;
      suggestedReply?: string;
      summary?: string;
      type?: string;
    } | null;
    risks?: string[];
    ruleMatches?: string[];
    summary?: string;
    targetFiles?: string[];
    suggestions?: string[];
    taskState?: string;
    verdict?: string;
  } | null;
  company: string;
  department: string;
  employeeCode: string;
  id: string;
  name: string;
  projectName: string;
  role: string;
  shell: string;
  permission: string;
  runtimeStatus: RuntimeStatus;
  workStatus: WorkStatus;
  taskIntakeStatus: TaskIntakeStatus;
  taskPriority: string | null;
  taskDeadline: string | null;
  taskSource: string | null;
  taskTimeWindow: string | null;
  recoveryPending: boolean;
  agentStatus: AgentStatus;
  currentTask: string;
  nextAction: string;
  progress: number;
  recentArtifact: string | null;
  recentCompleted: string | null;
  heartbeatLabel: string;
  workspace: string;
  repoSource: string;
  taskQueue: string[];
  blockedTasks: string[];
  diagnostics: string[];
  automationSettings: RuntimeAutomationSettings;
  runtimeInfo?: {
    codexSessionId?: string;
    lastAction?: string;
    pid?: number;
    resolvedShell?: string;
    sessionId?: string;
    startedAt?: string;
    status?: string;
    stoppedAt?: string | null;
  };
};

export type RuntimeFlowNode = Node<RuntimeMember, "runtimeNode">;

export type TerminalLine = {
  id: string;
  tone: "prompt" | "output" | "meta";
  text: string;
};

export type AgentDefinition = {
  id: string;
  name: string;
  scene: string;
  version: string;
  description: string;
  definitionText: string;
  tags: string[];
  repoSource: string;
};

export type ProjectNamingStrategy = "random32" | "snowflake32" | "datetime32";

export type NewEmployeeForm = {
  agentDefinitionText: string;
  autoTrustWorkspace: boolean;
  company: string;
  department: string;
  elevationMode: ElevationMode;
  employeeCode: string;
  name: string;
  promptAutomation: PromptAutomationMode;
  role: string;
  shell: string;
  systemAgentEnabled: boolean;
  permission: string;
  projectName: string;
  repoSource: string;
  workspace: string;
  currentTask: string;
};

export const shellOptions = ["PowerShell 7.5", "pwsh", "cmd"] as const;
export const permissionOptions = ["受限模式", "完全权限"] as const;
export const promptAutomationOptions = [
  { label: "手动确认", value: "manual" as const },
  { label: "安全提示自动处理", value: "safe_auto" as const },
] as const;
export const elevationModeOptions = [
  { label: "手动确认", value: "manual" as const },
  { label: "完全权限时自动批准", value: "auto_if_full_access" as const },
] as const;
export const departmentOptions = ["产品设计部", "工程研发部", "运营支持部"] as const;
export const roleOptions = [
  "高级产品设计师",
  "前端工程师",
  "后端工程师",
  "运营协调员",
] as const;

const BASE32_ALPHABET = "0123456789abcdefghijklmnopqrstuv";
let snowflakeSequence = 0n;

function bigIntToBase32(value: bigint) {
  if (value === 0n) {
    return "0";
  }

  let next = value;
  let result = "";
  while (next > 0n) {
    const digit = Number(next % 32n);
    result = BASE32_ALPHABET[digit] + result;
    next /= 32n;
  }
  return result;
}

function randomBase32(length = 10) {
  let output = "";
  while (output.length < length) {
    output += Math.random().toString(32).slice(2);
  }
  return output.slice(0, length);
}

function snowflakeBase32() {
  const epoch = 1735689600000n;
  const timestamp = BigInt(Date.now()) - epoch;
  snowflakeSequence = (snowflakeSequence + 1n) % 4096n;
  const workerId = 1n;
  const value = (timestamp << 22n) | (workerId << 12n) | snowflakeSequence;
  return bigIntToBase32(value);
}

function datetimeBase32() {
  return bigIntToBase32(BigInt(Date.now()));
}

export function generateProjectName(strategy: ProjectNamingStrategy) {
  switch (strategy) {
    case "random32":
      return `prj-${randomBase32(10)}`;
    case "snowflake32":
      return `prj-${snowflakeBase32()}`;
    case "datetime32":
      return `prj-${datetimeBase32()}`;
    default:
      return `prj-${randomBase32(10)}`;
  }
}

export const availableAgentDefinitions: AgentDefinition[] = [
  {
    id: "onboarding_companion_v2",
    name: "onboarding_companion_v2",
    scene: "新员工欢迎与流程跟进",
    version: "版本 2.4",
    description:
      "负责欢迎语生成、知识库引导、日报提醒和 30 天观察任务，适合新员工入职场景。",
    definitionText:
      "name: onboarding_companion_v2\nrole: 入职陪伴 Agent\nskills:\n- 欢迎流程编排\n- 知识库引导\n- 30 天任务提醒\nprompt: |\n  你负责协助新员工完成入职首周的系统熟悉、\n  权限开通确认与团队协作引导。",
    tags: ["欢迎过程", "流程同步", "知识问答"],
    repoSource:
      "github.com/c-agent/onboarding-repo/agents/onboarding_companion_v2.md",
  },
  {
    id: "design_review_partner",
    name: "design_review_partner",
    scene: "设计评审与规范提醒",
    version: "版本 1.8",
    description:
      "适用于设计岗位，帮助新成员同步设计系统、走查规范和评审节奏。",
    definitionText:
      "name: design_review_partner\nrole: 设计评审辅助 Agent\nskills:\n- 设计系统同步\n- 评审节奏提醒\n- 规范问题归档\nprompt: |\n  你负责帮助设计岗位成员完成设计系统熟悉、\n  评审前检查和规范偏差提示。",
    tags: ["设计系统", "规范同步", "评审节奏"],
    repoSource:
      "github.com/c-agent/design-repo/agents/design_review_partner.md",
  },
  {
    id: "workspace_operator_pro",
    name: "workspace_operator_pro",
    scene: "工位与权限初始化",
    version: "版本 3.1",
    description:
      "适合运营、行政和支持岗位，负责设备申请、账号开通和权限分组。",
    definitionText:
      "name: workspace_operator_pro\nrole: 工位运营 Agent\nskills:\n- 设备申请跟进\n- 账号开通提醒\n- 权限组初始化\nprompt: |\n  你负责新员工工位、设备和账号权限的初始化协作，\n  跟踪待办并同步阻塞项。",
    tags: ["工位设备", "权限分组", "账号开通"],
    repoSource:
      "github.com/c-agent/workspace-repo/agents/workspace_operator_pro.md",
  },
];

const ceoMember: RuntimeMember = {
  company: "公司3",
  department: "CEO",
  employeeCode: "CEO-001",
  id: "emp-ceo",
  name: "CEO / 主调度器",
  projectName: "task-001",
  role: "全局协调",
  shell: "PowerShell 7.5",
  permission: "受限模式",
  runtimeStatus: "running",
  workStatus: "busy",
  taskIntakeStatus: "none",
  taskPriority: null,
  taskDeadline: null,
  taskSource: null,
  taskTimeWindow: null,
  recoveryPending: false,
  agentStatus: "matched",
  currentTask: "恢复公司 3 的客户端运行时监督链路",
  nextAction: "确认服务端轮询策略与事件增量同步协议",
  progress: 0.72,
  recentArtifact: "任务进度报告.md",
  recentCompleted: "整理运行时健康定义",
  heartbeatLabel: "心跳 4 秒前",
  workspace: "D:/PROJECT/COMPANY/公司3/CEO/tasks/task-001",
  repoSource: "github.com/c-agent/supervisor/agents/ceo.md",
  taskQueue: ["整理运行时健康定义", "确定 active task 切换命令"],
  blockedTasks: [],
  diagnostics: ["Supervisor 已连接", "Agent 指纹匹配", "最近恢复成功"],
  automationSettings: {
    autoTrustWorkspace: true,
    elevationMode: "manual",
    promptAutomation: "safe_auto",
  },
};

const leaderMember: RuntimeMember = {
  company: "公司3",
  department: "部门1",
  employeeCode: "LEAD-001",
  id: "emp-leader-a",
  name: "部门 Leader A",
  projectName: "task-008",
  role: "任务跟进",
  shell: "pwsh",
  permission: "完全权限",
  runtimeStatus: "running",
  workStatus: "busy",
  taskIntakeStatus: "none",
  taskPriority: null,
  taskDeadline: null,
  taskSource: null,
  taskTimeWindow: null,
  recoveryPending: false,
  agentStatus: "matched",
  currentTask: "整理 CLI 存活探测与恢复顺序",
  nextAction: "拆成 start / verify / restore 三段式状态机",
  progress: 0.51,
  recentArtifact: null,
  recentCompleted: "检查员工 3 运行时",
  heartbeatLabel: "心跳 11 秒前",
  workspace: "D:/PROJECT/COMPANY/公司3/部门1/领导/tasks/task-008",
  repoSource: "github.com/c-agent/leader-runtime/agents/leader.md",
  taskQueue: ["检查员工 3 运行时", "等待服务端分配版本字段"],
  blockedTasks: [],
  diagnostics: ["Runtime 正常", "CLI 绑定有效", "任务切换未触发"],
  automationSettings: {
    autoTrustWorkspace: true,
    elevationMode: "auto_if_full_access",
    promptAutomation: "safe_auto",
  },
};

const developerRecoveringMember: RuntimeMember = {
  company: "公司3",
  department: "部门2",
  employeeCode: "EMP-2026-007",
  id: "emp-dev-b",
  name: "员工 07",
  projectName: "task-015",
  role: "实现执行",
  shell: "PowerShell 7.5",
  permission: "受限模式",
  runtimeStatus: "stopped",
  workStatus: "blocked",
  taskIntakeStatus: "pending_ack",
  taskPriority: "P1",
  taskDeadline: null,
  taskSource: "leader",
  taskTimeWindow: "today",
  recoveryPending: true,
  agentStatus: "unverified",
  currentTask: "从 task-015 目录恢复上下文",
  nextAction: "等待握手完成并装载 current_task.json",
  progress: 0.33,
  recentArtifact: null,
  recentCompleted: null,
  heartbeatLabel: "待恢复",
  workspace: "D:/PROJECT/COMPANY/公司3/部门2/员工7/tasks/task-015",
  repoSource: "github.com/c-agent/dev-runtime/agents/frontend.md",
  taskQueue: ["同步 snapshot.json", "补发恢复失败事件"],
  blockedTasks: ["服务端尚未返回 last_event_id"],
  diagnostics: ["检测到上次 session 已退出", "准备自动重启", "Agent 尚未验证"],
  automationSettings: {
    autoTrustWorkspace: true,
    elevationMode: "manual",
    promptAutomation: "manual",
  },
};

const developerBlockedMember: RuntimeMember = {
  company: "公司3",
  department: "部门3",
  employeeCode: "EMP-2026-012",
  id: "emp-dev-c",
  name: "员工 12",
  projectName: "task-021",
  role: "实现执行",
  shell: "pwsh",
  permission: "受限模式",
  runtimeStatus: "error",
  workStatus: "blocked",
  taskIntakeStatus: "planned",
  taskPriority: "P0",
  taskDeadline: null,
  taskSource: "CEO",
  taskTimeWindow: "immediate",
  recoveryPending: false,
  agentStatus: "mismatched",
  currentTask: "校验远程 Agent 定义来源",
  nextAction: "切换到 pinned commit 后重新拉起 CLI",
  progress: 0.28,
  recentArtifact: null,
  recentCompleted: null,
  heartbeatLabel: "心跳超时",
  workspace: "D:/PROJECT/COMPANY/公司3/部门3/员工12/tasks/task-021",
  repoSource: "github.com/c-agent/dev-runtime/agents/research.md",
  taskQueue: ["等待 Leader 重新分配", "补写 block.md"],
  blockedTasks: ["Agent fingerprint 不匹配", "远程定义发生漂移"],
  diagnostics: ["上次启动 14 分钟前", "握手校验失败", "建议执行 restart_session"],
  automationSettings: {
    autoTrustWorkspace: false,
    elevationMode: "manual",
    promptAutomation: "manual",
  },
};

export const initialRuntimeMembers: RuntimeMember[] = [
  ceoMember,
  leaderMember,
  developerRecoveringMember,
  developerBlockedMember,
];

const initialPositions = [
  { x: 44, y: 86 },
  { x: 472, y: 116 },
  { x: 186, y: 356 },
  { x: 746, y: 338 },
];

export function createRuntimeNode(member: RuntimeMember, index: number): RuntimeFlowNode {
  const position =
    initialPositions[index] ?? {
      x: 44 + (index % 3) * 390,
      y: 86 + Math.floor(index / 3) * 246,
    };

  return {
    id: member.id,
    type: "runtimeNode",
    position,
    data: member,
  };
}

export const initialRuntimeNodes = initialRuntimeMembers.map((member, index) =>
  createRuntimeNode(member, index),
);

export function createInitialTerminalLines(member: RuntimeMember): TerminalLine[] {
  return [
    {
      id: `${member.id}-boot-1`,
      tone: "prompt",
      text: `PS ${member.workspace.replaceAll("/", "\\")}> supervisor status`,
    },
    {
      id: `${member.id}-boot-2`,
      tone: "output",
      text: `session = sess-${member.id}`,
    },
    {
      id: `${member.id}-boot-3`,
      tone: "output",
      text: `current_task = ${member.currentTask}`,
    },
    {
      id: `${member.id}-boot-4`,
      tone: "meta",
      text: "已连接到本地 mock CLI，会话保持活动。",
    },
  ];
}

export function createRuntimeMember(form: NewEmployeeForm, index: number): RuntimeMember {
  const normalizedName = form.name.trim() || `员工 ${index + 1}`;
  const normalizedCompany = form.company.trim() || "未来智造科技";
  const normalizedDepartment = form.department.trim() || "产品设计部";
  const normalizedProjectName = form.projectName.trim() || `prj-${randomBase32(8)}`;
  const normalizedProjectRoot = (form.workspace.trim() || "D:/PROJECT/COMPANY").replace(
    /[\\/]+$/,
    "",
  );
  const idSeed = normalizedName
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  return {
    company: normalizedCompany,
    department: normalizedDepartment,
    employeeCode:
      form.employeeCode.trim() ||
      `EMP-2026-${String(index + 1).padStart(3, "0")}`,
    id: `emp-${idSeed || index + 1}-${Date.now().toString().slice(-5)}`,
    name: normalizedName,
    projectName: normalizedProjectName,
    role: form.role.trim() || "实现执行",
    shell: form.shell,
    permission: form.permission,
    runtimeStatus: "stopped",
    workStatus: "idle",
    taskIntakeStatus: "none",
    taskPriority: null,
    taskDeadline: null,
    taskSource: null,
    taskTimeWindow: null,
    recoveryPending: false,
    agentStatus: "unverified",
    currentTask: form.currentTask.trim() || "等待任务分配",
    nextAction: "启动 CLI 并执行握手校验",
    progress: 0.12,
    recentArtifact: null,
    recentCompleted: null,
    heartbeatLabel: "待启动",
    workspace: `${normalizedProjectRoot}/${normalizedCompany}/${normalizedDepartment}/${normalizedName.replaceAll(" ", "")}/${normalizedProjectName}`,
    repoSource:
      form.repoSource.trim() || "github.com/c-agent/default-runtime/agents/default.md",
    taskQueue: ["生成 snapshot.json", "初始化 current_task.json"],
    blockedTasks: [],
    diagnostics: [
      `员工编号 ${form.employeeCode.trim() || `EMP-2026-${String(index + 1).padStart(3, "0")}`}`,
      `项目 ${normalizedProjectName}`,
      "已创建员工运行时",
      "准备启动 CLI",
      "等待 Agent 验证",
    ],
    automationSettings: {
      autoTrustWorkspace: form.autoTrustWorkspace,
      elevationMode: form.elevationMode,
      promptAutomation: form.promptAutomation,
    },
  };
}

export function buildAssistantReply(member: RuntimeMember, command: string): string {
  const normalized = command.trim().toLowerCase();

  if (!normalized) {
    return "请输入一条命令或消息。";
  }

  if (normalized === "help") {
    return "可用命令：status, task, queue, diagnose, clear。";
  }

  if (normalized === "status") {
    return `runtime=${member.runtimeStatus}; work=${member.workStatus}; agent=${member.agentStatus}; heartbeat=${member.heartbeatLabel}`;
  }

  if (normalized === "task") {
    return `current_task=${member.currentTask}; next_action=${member.nextAction}`;
  }

  if (normalized === "queue") {
    return member.taskQueue.length
      ? `queued=${member.taskQueue.join(" | ")}`
      : "当前没有排队任务。";
  }

  if (normalized === "diagnose") {
    return member.diagnostics.join(" | ");
  }

  if (normalized === "clear") {
    return "__CLEAR__";
  }

  return `已记录输入 "${command}"，等待真实 Supervisor / PTY 桥接接入。`;
}
