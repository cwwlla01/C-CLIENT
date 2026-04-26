# 员工 Codex 运行时设计

## 当前目标

让客户端只做本地运行时宿主，不替 Codex 追加系统任务 prompt，不强制使用一整套 markdown 工作流。

## 目录模型

### 员工根目录

```text
{projectRoot}/{company}/{department}/{employee}/
  EMPLOYEE_AGENT.md
  employee.json
  projects.json
  deliveries-index.json
```

### 项目工作空间

```text
{projectRoot}/{company}/{department}/{employee}/{project}/
  AGENTS.md                 # 可选，启用员工模板时存在
  task_request.md           # 当前任务原文
  runtime/
    meta.json               # 客户端运行时状态
  references/              # 可选，有附件时创建
  artifacts/               # 可选，有成果时创建
```

## 文件职责

### `EMPLOYEE_AGENT.md`

- 员工级长期模板
- 由客户端维护
- 启用系统增强时复制到项目空间的 `AGENTS.md`

### `task_request.md`

- 保存用户原始任务
- 只包含任务原文、时间、来源、优先级、附件清单
- 不再写入系统要求、接单确认、计划模板

### `runtime/meta.json`

- 客户端运行时元数据
- 用于恢复、UI 展示、REST API
- 不作为 Codex 的系统 prompt 来源

关键字段示例：

```json
{
  "memberId": "emp-001",
  "workspacePath": "D:/PROJECT/COMPANY/.../prj-a",
  "status": "running",
  "taskStatus": "working",
  "lastTaskSummary": "请创建 hello.txt",
  "lastTaskAssignedAt": "2026-04-25T16:57:12.218Z",
  "lastTaskCompletedAt": null,
  "pendingLaunchPrompt": null,
  "pid": 12345,
  "sessionId": "sess-xxxx",
  "codexSessionId": "019d..."
}
```

### `projects.json`

- 员工级项目索引
- 记录当前项目、每个项目最近任务和项目状态

项目状态当前只用：

- `idle`
- `assigned`
- `queued`
- `working`
- `blocked`
- `done`

### `deliveries-index.json`

- 员工级成果索引
- 聚合各项目下的成果文件

## Codex 启动原则

### 无任务启动

- 只进入目录启动 Codex
- 不发送任何系统解释 prompt

### 有任务启动

- 只发送用户任务原文
- 如果有附件，只补文件路径

示意：

```text
请创建 hello.txt，并写入 hello world

参考文件路径：
- D:/PROJECT/COMPANY/.../references/mock.png
```

## 不再使用的旧流程

当前实现不再依赖：

- `startup_ack.md`
- `plan.md`
- `current.md`
- `wait_finished.md`
- `finished.md`
- `block.md`
- `restore_summary.md`
- `codex_bootstrap.md`

## 当前运行状态来源

客户端 UI 主要从两处取值：

1. `runtime/meta.json`
2. `projects.json`

不再要求 Codex 通过固定 markdown 文件回写状态。

## 成果归档

- 成果文件统一放在 `artifacts/`
- 员工级聚合通过 `deliveries-index.json`
- 客户端“完成任务”动作会默认生成一个 `artifacts/completion_xxx.md`，作为最小归档结果

## 当前结论

当前客户端已经收敛到：

- 任务原文直达 Codex
- 系统状态旁路存储
- 员工模板与项目规则分层
- 旧 markdown 任务流退出主链路
