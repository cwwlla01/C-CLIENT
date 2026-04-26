# feature/inspector-runtime-mvp 分支变更说明

> 本文档说明当前 `feature/inspector-runtime-mvp` 分支相对主分支的主要改动。

## 一、总体目标

本分支把客户端从“重 markdown 工作流 + 单纯终端托管”改造成了：

- 更轻量的员工 / 项目空间模型
- 任务直达 Codex CLI 的执行链路
- 本地观察者（Inspector）机制
- 审核消息中心与自动驾驶基础版
- 更可用的终端详情与运行时信息展示

---

## 二、目录与状态模型调整

### 1. 员工根目录收敛

保留：

- `EMPLOYEE_AGENT.md`
- `employee.json`
- `projects.json`
- `deliveries-index.json`

移除主链路依赖：

- `current-project.json`
- `dispatch-queue.json`

### 2. 项目空间收敛

当前主链路保留：

- `AGENTS.md`（可选）
- `task_request.md`
- `runtime/meta.json`
- `references/`（按需）
- `artifacts/`（按需）

退出主链路：

- `startup_ack.md`
- `plan.md`
- `current.md`
- `wait_finished.md`
- `finished.md`
- `block.md`
- `restore_summary.md`
- `codex_bootstrap.md`

---

## 三、任务执行链路调整

### 1. 任务原文直达 Codex

当前行为：

- 无任务启动时，不发送系统解释 prompt
- 有任务时，只把用户任务原文发给 Codex
- 有附件时，只补文件路径

### 2. 运行中会话补发任务

修复了：

- 任务写入成功但 CLI 未真正收到
- 复用现有会话时 `pendingLaunchPrompt` 漏发

当前行为：

- 若员工会话已存在且目标工作空间一致，会自动补发任务
- 若员工未真正运行，会强制启动并送入任务

### 3. 发布任务后的定向状态回刷

修复了：

- 卡片状态与后端真实状态不一致
- 前端仍显示“等待启动 / 旧任务”问题

当前行为：

- 发布任务后先全局刷新
- 再定向拉取当前员工的最新运行态覆盖卡片

---

## 四、观察者（Inspector）MVP

### 1. 配置体系

新增：

- `setting/inspector.json`

支持：

- `inspectionMode`
- `autopilotMode`
- `autoReplyEnabled`
- `highRiskAlwaysManual`
- 阈值配置
- 回复偏好
- 独立 Inspector AI 配置

### 2. 规则引擎

当前规则已覆盖：

- `prompt_returned`
- `silence_window_reached`
- `completion_keyword`
- `artifact_created`
- `target_file_created`
- `permission_denied`
- `missing_dependency`
- `execution_failed`

### 3. 目标文件识别

新增：

- 从任务文本中提取目标文件候选
- 检查目标文件是否实际存在
- 未命中时给出“缺目标文件”提示

并修复：

- 把截止时间等时间戳误识别为文件名的问题

### 4. 观察结果文件

新增：

- `runtime/inspector-last.json`

当前包含：

- `taskState`
- `verdict`
- `confidence`
- `summary`
- `ruleMatches`
- `risks`
- `suggestions`
- `replyCandidate`
- `targetFiles`
- `matchedTargetFiles`
- `missingTargetFiles`
- `lastSilenceSeconds`
- `aiUsed`
- `aiError`
- `aiConfidence`
- `aiReason`
- `replyConfidence`
- `decisionSource`
- `lastAutoReplyAt`

### 5. 自动驾驶基础版

当前支持：

- `suggest_only`
- `safe_auto`
- `full_auto` 起步版

观察者当前默认只处理真正需要判断的问题：

- `choice_ab`
- `choice_numeric`
- `confirm_yes_no`

不再处理：

- `continue_prompt`
- `trust_prompt`

这两类固定提示改由原生提示自动化处理，避免重复回车 / 重复建议。

### 6. AI 兜底

已接入独立 Inspector AI：

- `inspectionMode = hybrid | ai_only` 时可触发
- 使用独立 `baseUrl / apiKey / model`
- 仅在规则不足时补充评审

已补：

- `POST /api/settings/inspector/test`
- 设置页 Inspector AI 连通性测试
- UI 中显示 AI 兜底、AI 置信度、AI 判断依据

---

## 五、审核消息中心增强

### 1. 观察者建议接入审核消息

新增：

- 观察者建议会进入“审核消息”
- 可直接采纳 / 忽略

### 2. 审核消息信息增强

新增显示：

- 观察者建议标签
- 回复类型
- 风险级别
- 建议回复正文

### 3. 处理后刷新

修复了：

- 处理审核消息后卡片和详情状态不刷新

当前行为：

- 处理后自动刷新审核消息、员工卡片、详情观察结果

---

## 六、终端窗口增强

### 1. 底部区域改为 Codex 基本信息

移除底部输入框，改为展示：

- 本地会话 ID
- Codex 会话 ID
- 配置模型 / 推理强度
- 进程 ID / 权限模式

### 2. 终端体验增强

新增：

- 暂停跟随 / 恢复跟随
- 清屏
- 新输出提示

### 3. 终端降噪

新增：

- MCP 启动噪音折叠
- 噪音计数
- 最近折叠摘要

### 4. 显示收敛

修复了：

- 开头多余空行
- 连续大量空行导致的视觉跳动

### 5. Codex 会话 ID 发现与显示

修复了：

- `employee/status` 中 live session 空值遮挡 meta 中真实 `codexSessionId`
- 终端窗口打开后会主动轮询最新状态回填 `codexSessionId`

---

## 七、设置页增强

### 新增 Tab

- `观察者配置`

支持：

- 观察者开关
- 自动驾驶模式
- 阈值与偏好
- Inspector AI 配置
- Inspector AI 连通性测试

---

## 八、Docker / GitHub Actions

### 1. Docker 相关

- 保持现有 Dockerfile / compose 文档更新

### 2. GitHub Actions

新增：

- `.github/workflows/docker-branch-publish.yml`

能力：

- push 分支时构建镜像
- 推送到 Docker Hub
- 自动打分支 tag / sha tag
- 主分支额外打 `latest`

---

## 九、主要修复类问题汇总

本分支已修复的关键问题包括：

- 发布任务后员工 CLI 没真正收到任务
- 复用会话时任务漏发
- 卡片状态与后端真实状态不一致
- 观察者把固定提示误当成决策问题
- 观察者误报缺目标文件
- 审核消息处理后 UI 不刷新
- 终端底部看不到 Codex 会话 ID
- 终端噪音过多、空行过多、自动滚动影响阅读

---

## 十、当前分支状态

当前 `feature/inspector-runtime-mvp` 已经是一版可运行的 MVP，具备：

- 轻量任务执行流
- 观察者规则评审
- 自动驾驶基础版
- AI 兜底
- 审核消息中心整合
- 终端体验增强

后续如果继续演进，建议优先做：

1. 观察者 AI 策略进一步细化
2. 员工卡片与详情页视觉打磨
3. 更完整的回归测试与 PR 文案整理
