# 本地 API 参考

## 1. 健康检查

### `GET /health`

返回：

```json
{
  "ok": true,
  "bridgePort": 4281,
  "sessionCount": 0
}
```

## 2. 工作空间接口

### `POST /api/workspace/init`

作用：

- 初始化员工项目空间

响应示例：

```json
{
  "created": true,
  "files": ["AGENTS.md", "runtime/meta.json"],
  "workspacePath": "D:/PROJECT/COMPANY/未来智造科技/产品设计部/小白/prj-xxxx"
}
```

说明：

- 员工根目录会写入：
  - `EMPLOYEE_AGENT.md`
  - `employee.json`
  - `projects.json`
  - `deliveries-index.json`
- 项目空间默认最小化

### `POST /api/workspace/discover`

作用：

- 扫描项目根路径下员工项目空间

响应字段：

- `companies`
- `runtimes`

每个 `runtime` 主要包含：

- 公司 / 部门 / 员工名 / 员工编号
- 当前项目
- 当前任务 / 下一步
- 运行状态 / 工作状态
- `sessionId` / `pid`
- `workspacePath`
- 最近成果

### `POST /api/workspace/history`

作用：

- 获取员工工作成果聚合视图

返回：

- `artifacts`
- `finished`

当前主用 `artifacts`，`finished` 已保留为空兼容位。

### `POST /api/workspace/projects`

作用：

- 获取员工名下全部项目空间

项目状态当前为：

- `空闲`
- `待启动`
- `排队中`
- `执行中`
- `阻塞`
- `已完成`

### `POST /api/workspace/member-config`

作用：

- 更新员工运行策略

支持字段：

- `permission`
- `autoTrustWorkspace`
- `promptAutomation`
- `elevationMode`

## 3. 员工接口

### `POST /api/employee/info`

返回员工基础信息：

- 公司 / 部门 / 员工名 / 员工编号
- 当前项目
- 当前工作空间
- 员工根目录
- 权限 / shell / role / repoSource

### `POST /api/employee/status`

返回员工当前状态：

- `runtimeStatus`
- `workStatus`
- `currentProject`
- `currentTask`
- `nextAction`
- `sessionId`
- `pid`
- `startedAt`
- `stoppedAt`
- `recoveryPending`
- `workspacePath`

### `POST /api/employee/tasks`

返回员工任务概览：

- `currentProject`
- `currentTask`
- `nextAction`
- `queuedProjects`
- `queuedProjectCount`
- `projects`

### `POST /api/employee/projects`

员工维度的项目空间接口，等价于 `/api/workspace/projects`

### `POST /api/employee/projects/switch`

尝试切换到指定项目。

返回 `mode`：

- `switched`
- `unchanged`
- `blocked_active_task`

### `POST /api/employee/deliveries`

获取员工成果聚合结果。

### `POST /api/employee/delete`

删除整个员工根目录，并在删除前终止活动会话。

## 4. 任务接口

### `POST /api/task/assign`

作用：

- 发布任务到指定项目空间

当前行为：

1. 写 `task_request.md`
2. 有附件则写 `references/`
3. 更新 `runtime/meta.json`
4. 更新 `projects.json`
5. 必要时启动或切换 Codex 会话

响应重点：

- `mode`
  - `current`
  - `queued`
  - `project_switch`
  - `queued_project`
- `projectName`
- `switchWorkspacePath`
- `currentTask`
- `attachments`

### `POST /api/task/complete`

作用：

- 完成当前任务

当前行为：

1. 生成 `artifacts/completion_xxx.md`
2. 更新 `deliveries-index.json`
3. 更新 `runtime/meta.json`
4. 更新 `projects.json`

响应字段：

- `completed`
- `completedTask`
- `artifactFileName`
- `hasNextTask`
- `nextTask`
- `switchWorkspacePath`
- `switchProjectName`

## 5. 运行时接口

### `POST /api/runtime/start`

作用：

- 启动员工 CLI 会话

当前行为：

- 无任务时不发送系统 prompt
- 有任务时只发送用户任务原文
- 有附件时只补文件路径

响应：

```json
{
  "started": true,
  "sessionId": "sess-xxxx",
  "pid": 12345,
  "launchMode": "codex",
  "resolvedShell": "codex",
  "startedAt": "2026-04-25T16:57:26.078Z",
  "codexResumeUsed": false,
  "codexSessionId": null
}
```

### `POST /api/runtime/stop`

- 停止员工会话

### `POST /api/runtime/restart`

- 重启员工会话

### `GET /api/runtime/prompts`

- 返回当前待确认提示与处理日志

## 6. 观察者接口

### `POST /api/settings/inspector/load`

作用：

- 读取 `{projectRoot}/setting/inspector.json`

返回：

- `filePath`
- `settings`

### `POST /api/settings/inspector/save`

作用：

- 保存观察者配置

配置当前包含：

- `inspectionMode`
- `autopilotMode`
- `autoReplyEnabled`
- `highRiskAlwaysManual`
- `thresholds`
- `preferences`
- `allowedReplyTypes`
- `blockedReplyTypes`
- `ai`

### `POST /api/settings/inspector/test`

作用：

- 测试 Inspector 独立 AI 配置连通性

当前实现：

- 请求 `GET {baseUrl}/models`
- 返回延迟、模型数量、模型列表

### `POST /api/inspector/review`

作用：

- 立即对指定员工项目空间执行一次观察者检查

请求体：

```json
{
  "memberId": "emp-x",
  "workspacePath": "D:/PROJECT/COMPANY/.../employee/project"
}
```

响应：

- `ok`
- `result`

### `POST /api/inspector/reply`

作用：

- 把观察者建议回复直接写回员工当前 CLI

请求体：

```json
{
  "memberId": "emp-x",
  "workspacePath": "D:/PROJECT/COMPANY/.../employee/project",
  "replyText": "A"
}
```

响应：

- `ok`
- `memberId`
- `replyText`

## 7. 下载接口

### `GET /api/download/file`

- 下载单个成果文件

### `GET /api/download/results`

- 下载项目级或员工级成果包
