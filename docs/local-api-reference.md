# 本地 REST / WebSocket API 参考

## 1. 概览

当前本地 bridge 默认地址：

- HTTP: `http://127.0.0.1:4281`
- WebSocket: `ws://127.0.0.1:4281/terminal`

这份文档只记录“当前代码里已经实现”的本地接口，不记录未来设想中的协议。

## 1.1 鉴权说明

当前版本支持可选开启的 API Key 鉴权。

- 配置文件：`{项目路径}/setting/security.json`
- REST 请求头：`X-CClient-Key`
- WebSocket 查询参数：`token`

当鉴权开启时：

- 除 `/health` 和 `POST /api/settings/security/load` 外，其余接口都要求正确的 API Key
- `/terminal` WebSocket 也要求带 `token`

## 1.2 Codex 配置说明

当前版本已支持从本地 bridge 读取和保存 Codex 配置。

- 默认目录：`{CODEX_HOME}`
- 若未设置 `CODEX_HOME`，默认使用 `~/.codex`
- 配置文件：
  - `config.toml`
  - `auth.json`

当前 UI 的首次启动引导和设置页里的 `Codex 配置` tab 都使用同一套接口。

另外，当前项目空间中的规则文件模型已经调整为：

- `AGENTS.md`
  - 项目空间级长期规则
- `ROLE.md`
  - 员工角色定义快照
- `workspace_guide.md`
  - 给人类和调试场景阅读的补充说明

`AGENTS.md` 的模板来源：

- `{项目路径}/setting/templates/AGENTS.md`

初始化项目空间时会自动复制到：

- `{workspacePath}/AGENTS.md`

## 2. 健康检查

### `GET /health`

作用：

- 检查 bridge 是否存活

响应示例：

```json
{
  "ok": true,
  "bridgePort": 4281,
  "sessionCount": 3
}
```

## 3. 工作空间接口

### `POST /api/settings/security/load`

作用：

- 读取当前本地 API 鉴权开关状态

请求体：

```json
{
  "projectRoot": "D:/PROJECT/COMPANY"
}
```

响应：

```json
{
  "enabled": false,
  "filePath": "D:/PROJECT/COMPANY/setting/security.json"
}
```

### `POST /api/settings/security/save`

作用：

- 保存本地 API 鉴权配置

请求体：

```json
{
  "projectRoot": "D:/PROJECT/COMPANY",
  "enabled": true,
  "apiKey": "YOUR_KEY"
}
```

响应：

```json
{
  "enabled": true,
  "filePath": "D:/PROJECT/COMPANY/setting/security.json"
}
```

### `POST /api/settings/codex/load`

作用：

- 读取本地 Codex 配置状态
- 返回 `config.toml` / `auth.json` 路径
- 返回当前是否已完成基础配置
- 返回当前环境是否检测到 `codex` 命令

请求体：

```json
{}
```

响应关键字段：

- `codexHome`
- `configPath`
- `authPath`
- `codexCommandAvailable`
- `configured`
- `config`
- `auth`
- `configToml`
- `authJson`

### `POST /api/settings/codex/save`

作用：

- 保存 Codex 配置
- 支持表单字段保存
- 支持直接写入 `configToml`

请求体示例：

```json
{
  "config": {
    "modelProvider": "custom",
    "model": "gpt-5.4",
    "reviewModel": "gpt-5.4",
    "modelReasoningEffort": "xhigh",
    "disableResponseStorage": true,
    "networkAccess": "enabled",
    "windowsWslSetupAcknowledged": true,
    "modelContextWindow": 1000000,
    "modelAutoCompactTokenLimit": 900000,
    "providerName": "custom",
    "wireApi": "responses",
    "baseUrl": "https://cpa.56781234.xyz/v1"
  },
  "auth": {
    "OPENAI_API_KEY": "ap-xxxx",
    "authMode": "apikey"
  }
}
```

说明：

- 若同时传入 `configToml`，后端会优先按 `configToml` 原文保存
- `auth.json` 仍由结构化字段生成

### `POST /api/settings/codex/test`

作用：

- 对当前 Codex 配置做连通性测试
- 当前版本通过请求 `{baseUrl}/models` 验证可用性

请求体示例：

```json
{
  "configToml": "model_provider = \"custom\"\n...",
  "auth": {
    "OPENAI_API_KEY": "ap-xxxx",
    "authMode": "apikey"
  }
}
```

响应示例：

```json
{
  "ok": true,
  "message": "连接成功，已识别 2 个模型",
  "latencyMs": 182,
  "modelCount": 2,
  "models": ["gpt-5.4", "gpt-5.4-mini"],
  "testedUrl": "https://xxx/v1/models"
}
```

### `POST /api/workspace/init`

作用：

- 初始化一个员工项目工作空间

请求体核心字段：

```json
{
  "projectRoot": "D:/PROJECT/COMPANY",
  "company": "未来智造科技",
  "department": "产品设计部",
  "employeeName": "小白",
  "employeeCode": "EMP-2026-001",
  "memberId": "emp-x",
  "projectName": "prj-xxxx",
  "role": "高级产品设计师",
  "shell": "PowerShell 7.5",
  "permission": "受限模式",
  "repoSource": "github.com/...",
  "agentDefinitionText": "..."
}
```

响应示例：

```json
{
  "created": true,
  "files": [
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
    "references/"
  ],
  "workspacePath": "D:/PROJECT/COMPANY/未来智造科技/产品设计部/小白/prj-xxxx"
}
```

补充说明：

- 当前实现会自动确保 `{projectRoot}/setting/templates/AGENTS.md` 存在
- 然后把模板复制到当前项目空间生成 `AGENTS.md`
- 员工角色文件写入 `ROLE.md`
- 初始化时会预创建 `references/`，用于保存任务附带的参考资料

### `POST /api/workspace/discover`

作用：

- 扫描项目路径下全部员工工作空间

请求体：

```json
{
  "projectRoot": "D:/PROJECT/COMPANY"
}
```

响应字段：

- `companies`
- `runtimes`

每个 `runtime` 当前包含：

- 公司 / 部门 / 员工名 / 员工编号
- 当前项目名
- 当前任务 / 下一步
- 运行状态 / 工作状态
- sessionId / pid（仅 live session）
- 工作空间路径
- 自动化策略
- 最近完成 / 最近交付物

### `POST /api/workspace/history`

作用：

- 获取某员工的工作成果聚合视图

请求体：

```json
{
  "workspacePath": "D:/PROJECT/COMPANY/.../employee/current-project"
}
```

响应字段：

- `artifacts`
- `finished`

特点：

- 优先读员工根目录的 `deliveries-index.json`
- 若索引为空，则回退扫描该员工名下全部项目目录

### `POST /api/workspace/projects`

作用：

- 获取某员工名下所有项目空间

请求体：

```json
{
  "workspacePath": "D:/PROJECT/COMPANY/.../employee/current-project"
}
```

响应示例：

```json
{
  "projects": [
    {
      "projectName": "prj-a",
      "status": "当前项目",
      "isCurrent": true,
      "queued": false,
      "currentTask": "整理 Java 的版本特性",
      "nextAction": "等待新的任务指派",
      "updatedAt": "2026-04-15T01:48:00.000Z",
      "workspacePath": "D:/PROJECT/..."
    }
  ]
}
```

### `POST /api/workspace/member-config`

作用：

- 更新员工级运行策略

请求体：

```json
{
  "memberId": "emp-x",
  "workspacePath": "D:/PROJECT/...",
  "permission": "受限模式",
  "autoTrustWorkspace": true,
  "promptAutomation": "safe_auto",
  "elevationMode": "manual"
}
```

响应示例：

```json
{
  "ok": true,
  "workspacePath": "D:/PROJECT/...",
  "permission": "受限模式",
  "autoTrustWorkspace": true,
  "promptAutomation": "safe_auto",
  "elevationMode": "manual"
}
```

## 4. 员工维度接口

### `POST /api/employee/info`

作用：

- 获取员工基础信息与当前空间信息

请求体：

```json
{
  "workspacePath": "D:/PROJECT/COMPANY/.../employee/current-project"
}
```

响应字段：

- `employee.company`
- `employee.department`
- `employee.employeeName`
- `employee.employeeCode`
- `employee.memberId`
- `employee.role`
- `employee.permission`
- `employee.shell`
- `employee.repoSource`
- `employee.employeeRoot`
- `employee.currentProject`
- `employee.currentWorkspace`

### `POST /api/employee/status`

作用：

- 获取员工当前运行状态快照

请求体：

```json
{
  "workspacePath": "D:/PROJECT/COMPANY/.../employee/current-project"
}
```

响应字段：

- `status.runtimeStatus`
- `status.workStatus`
- `status.currentProject`
- `status.currentTask`
- `status.nextAction`
- `status.sessionId`
- `status.pid`
- `status.startedAt`
- `status.stoppedAt`
- `status.recoveryPending`
- `status.workspacePath`

### `POST /api/employee/tasks`

作用：

- 获取员工级任务概览

响应字段：

- `tasks.currentProject`
- `tasks.currentTask`
- `tasks.nextAction`
- `tasks.queuedProjects`
- `tasks.queuedProjectCount`
- `tasks.projects`

### `POST /api/employee/projects`

作用：

- 获取员工名下全部项目空间

说明：

- 这是 `/api/workspace/projects` 的员工维度别名接口

### `POST /api/employee/projects/switch`

作用：

- 尝试把员工切到指定项目空间

说明：

- 若当前没有执行中任务，则返回可切换结果
- 若当前仍有执行中任务，则返回阻塞结果，不会强切

请求体：

```json
{
  "workspacePath": "D:/PROJECT/COMPANY/.../employee/current-project",
  "targetWorkspacePath": "D:/PROJECT/COMPANY/.../employee/target-project"
}
```

响应关键字段：

- `mode`
  - `switched`
  - `unchanged`
  - `blocked_active_task`
- `projectName`
- `workspacePath`
- `currentTask`

### `POST /api/employee/deliveries`

作用：

- 获取员工级交付物聚合结果

说明：

- 这是 `/api/workspace/history` 的员工维度别名接口，返回 `deliveries.artifacts / deliveries.finished`

### `POST /api/employee/delete`

作用：

- 删除一个员工
- 删除范围是整个员工根目录
- 会连同该员工名下全部项目空间一起删除
- 若该员工当前存在活动 CLI，会先终止会话

请求体：

```json
{
  "workspacePath": "D:/PROJECT/COMPANY/.../employee/current-project"
}
```

响应示例：

```json
{
  "deleted": true,
  "employeeName": "小白",
  "employeeRoot": "D:/PROJECT/COMPANY/.../employee",
  "memberId": "emp-x",
  "workspacePath": "D:/PROJECT/COMPANY/.../employee/current-project"
}
```

## 5. 任务接口

### `POST /api/task/assign`

作用：

- 发布需求到某个员工
- 支持同项目分配或跨项目分配

请求体核心字段：

```json
{
  "memberId": "emp-x",
  "employeeName": "小白",
  "company": "未来智造科技",
  "department": "产品设计部",
  "workspacePath": "D:/PROJECT/...",
  "projectName": "prj-xxxx",
  "taskDescription": "整理 Java 的版本特性",
  "priority": "P1",
  "timeWindow": "today",
  "deadlineAt": "",
  "source": "手动发布",
  "forceCurrent": false,
  "attachments": [
    {
      "name": "原型图.png",
      "mimeType": "image/png",
      "size": 238199,
      "contentBase64": "...",
      "isImage": true
    }
  ]
}
```

响应关键字段：

- `mode`
  - `current`
  - `queued`
  - `project_switch`
  - `queued_project`
- `projectName`
- `switchWorkspacePath`
- `currentTask`
- `attachments`

补充说明：

- 任务附带文件会保存到当前项目空间的 `references/`
- `task_request.md` 会自动追加参考资料清单
- 图片类参考资料会记录到 `runtime/meta.json`，供新启动的 Codex 会话作为图片输入使用

### `POST /api/task/retry-startup-ack`

作用：

- 重试 `startup_ack.md` 的首轮确认

请求体：

```json
{
  "workspacePath": "D:/PROJECT/...",
  "permission": "受限模式",
  "shell": "PowerShell 7.5"
}
```

### `POST /api/task/complete`

作用：

- 完成当前任务
- 写入 `finished.md`
- 生成 `artifacts/completion_xxx.md`
- 推进项目内待办
- 若员工级切换队列里有下一个项目，则返回切换目标

请求体：

```json
{
  "workspacePath": "D:/PROJECT/..."
}
```

响应关键字段：

- `completed`
- `completedTask`
- `hasNextTask`
- `nextTask`
- `switchWorkspacePath`
- `switchProjectName`

## 6. 运行时接口

### `POST /api/runtime/start`

作用：

- 启动员工 CLI 会话

请求体：

```json
{
  "memberId": "emp-x",
  "cwd": "D:/PROJECT/...",
  "permission": "受限模式",
  "shell": "PowerShell 7.5",
  "cols": 120,
  "rows": 30
}
```

响应字段：

- `cwd`
- `launchMode`
- `pid`
- `reused`
- `startedAt`
- `resolvedShell`
- `sessionId`
- `started`

### `POST /api/runtime/restart`

作用：

- 停掉当前会话后重新拉起

请求体和 `/api/runtime/start` 基本一致。

### `POST /api/runtime/stop`

作用：

- 停止员工 CLI 会话

请求体：

```json
{
  "memberId": "emp-x",
  "cwd": "D:/PROJECT/..."
}
```

响应：

```json
{
  "memberId": "emp-x",
  "stopped": true
}
```

### `POST /api/terminate`

作用：

- 低层强制终止指定 `memberId` 的 session

请求体：

```json
{
  "memberId": "emp-x"
}
```

响应：

- `204 No Content`

## 7. 审核消息接口

### `GET /api/runtime/prompts`

作用：

- 获取当前待审核消息
- 获取最近处理日志

响应示例：

```json
{
  "prompts": [
    {
      "id": "xxx",
      "memberId": "emp-x",
      "title": "信任工作空间",
      "summary": "Codex 正在询问是否信任当前员工工作空间。",
      "responseMode": "approve_reject",
      "workspacePath": "D:/PROJECT/...",
      "createdAt": "2026-04-15T10:00:00.000Z"
    }
  ],
  "logs": [
    {
      "title": "继续执行提示",
      "summary": "命中安全提示，已自动按回车继续。",
      "mode": "自动处理",
      "action": "继续执行",
      "memberId": "emp-x",
      "workspacePath": "D:/PROJECT/...",
      "createdAt": "2026-04-15T10:01:00.000Z"
    }
  ]
}
```

### `POST /api/runtime/prompts/respond`

作用：

- 处理一条待审核消息

请求体：

```json
{
  "promptId": "xxx",
  "action": "approve"
}
```

当前支持动作：

- `approve`
- `reject`
- `continue`
- `dismiss`

## 8. 规则配置接口

### `POST /api/settings/prompt-rules/load`

作用：

- 读取提示白名单

请求体：

```json
{
  "projectRoot": "D:/PROJECT/COMPANY"
}
```

响应：

```json
{
  "filePath": "D:/PROJECT/COMPANY/setting/prompt-rules.json",
  "rules": []
}
```

### `POST /api/settings/prompt-rules/save`

作用：

- 保存提示白名单

请求体：

```json
{
  "projectRoot": "D:/PROJECT/COMPANY",
  "rules": [
    {
      "id": "rule-enter-1",
      "name": "继续执行提示",
      "pattern": "Press enter to continue",
      "action": "enter",
      "enabled": true
    }
  ]
}
```

响应：

- `filePath`
- `rules`

## 9. 路径与仓库接口

### `GET /api/download/file`

作用：

- 直接下载单个交付物文件

查询参数：

- `path`
- `workspacePath`
- `filename`（可选）
- `token`（启用 API 鉴权时必填）

示例：

```text
GET /api/download/file?path=D%3A%2FPROJECT%2F...%2Fartifacts%2Fresult.md&workspacePath=D%3A%2FPROJECT%2F...%2Fprj-001
```

说明：

- 返回文件流
- `Content-Disposition` 会强制浏览器下载

### `GET /api/download/archive`

作用：

- 下载成果压缩包

查询参数：

- `workspacePath`
- `scope`
  - `project`
  - `employee`
- `token`（启用 API 鉴权时必填）

示例：

```text
GET /api/download/archive?workspacePath=D%3A%2FPROJECT%2F...%2Fprj-001&scope=project
```

说明：

- `scope=project`
  - 打包当前项目下的 `finished.md` 与 `artifacts/`
- `scope=employee`
  - 打包当前员工名下全部项目的成果
- 返回 `application/zip`

### `POST /api/path/open`

作用：

- 打开本地文件或目录

请求体：

```json
{
  "path": "D:/PROJECT/..."
}
```

### `POST /api/agent-repo/list`

作用：

- 拉取并解析 Agent 仓库定义

请求体：

```json
{
  "repoUrl": "https://github.com/jnMetaCode/agency-agents-zh",
  "cacheRoot": "D:/PROJECT/COMPANY/setting/agent-repo",
  "refresh": true
}
```

响应字段：

- `agents`
- `commit`
- `cacheRoot`
- `repoUrl`
- `warning`

## 10. WebSocket 终端接口

### `WS /terminal`

查询参数：

- `memberId`
- `attachOnly`
- `shell`
- `cwd`
- `cols`
- `rows`
- `token`（启用 API 鉴权时必填）

说明：

- `attachOnly=1`
  - 只附着现有 session
  - 若没有活动会话则返回错误
- 不传 `attachOnly`
  - bridge 会自动创建或复用会话

### 9.1 服务端推送消息

- `ready`
- `output`
- `meta`
- `exit`
- `error`

### 9.2 客户端发送消息

- `input`

```json
{
  "type": "input",
  "data": "ls\r"
}
```

- `resize`

```json
{
  "type": "resize",
  "cols": 120,
  "rows": 30
}
```

- `terminate`

```json
{
  "type": "terminate"
}
```
