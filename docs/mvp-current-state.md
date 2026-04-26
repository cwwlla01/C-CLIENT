# MVP 当前版本说明

## 当前版本定位

这是一个可运行的本地 Codex CLI 宿主 MVP。

核心能力：

- 员工创建
- 项目空间初始化
- 任务发布
- CLI 启停与终端接入
- 项目状态与成果聚合
- 本地 REST / WebSocket

## 当前目录模型

### 员工根目录

- `EMPLOYEE_AGENT.md`
- `employee.json`
- `projects.json`
- `deliveries-index.json`

### 项目空间

- `AGENTS.md`（可选）
- `task_request.md`
- `runtime/meta.json`
- `references/`（按需）
- `artifacts/`（按需）

## 当前启动策略

### 没有任务

- 启动 Codex
- 不发送系统 prompt

### 有任务

- 只发送用户任务原文
- 若有附件，追加附件路径

## 当前状态模型

项目状态：

- `idle`
- `assigned`
- `queued`
- `working`
- `blocked`
- `done`

运行状态：

- `running`
- `stopped`
- `error`

## 当前成果模型

- 项目空间下的 `artifacts/` 保存文件
- 员工根目录下的 `deliveries-index.json` 做聚合索引

## 当前已删除的旧主链路

以下文件不再作为主流程依赖：

- `startup_ack.md`
- `plan.md`
- `current.md`
- `wait_finished.md`
- `finished.md`
- `block.md`
- `restore_summary.md`
- `codex_bootstrap.md`

## 当前剩余工作

1. 继续统一文档和接口说明
2. 再做一轮 UI 细节校验
3. 清理更多历史兼容代码
