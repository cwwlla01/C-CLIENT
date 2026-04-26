# 客户端运行时架构

## 架构目标

`C-CLIENT` 当前定位为本地运行时宿主。

它负责：

- 初始化员工目录与项目空间
- 启动 / 停止 / 重启 Codex CLI
- 保存本地运行时状态
- 通过 REST / WebSocket 向 UI 暴露状态和终端流

它不负责：

- CEO / Leader / 员工多级调度逻辑
- 业务规划真相源
- 替 Codex 设计任务理解 prompt

## 组成

### 1. 前端 UI

- React + Vite
- daisyUI 风格组件
- 员工卡片、终端详情、项目空间、工作成果、设置

### 2. 本地 Bridge

- Node.js
- `node-pty` 管理终端进程
- 暴露本地 REST / WebSocket
- 保存和读取工作空间状态文件

### 3. 文件状态层

主要文件：

- 员工根目录：
  - `EMPLOYEE_AGENT.md`
  - `employee.json`
  - `projects.json`
  - `deliveries-index.json`
- 项目空间：
  - `AGENTS.md`
  - `task_request.md`
  - `runtime/meta.json`
  - `references/`
  - `artifacts/`

## 运行主链路

### 新建员工

1. 创建员工根目录
2. 写入 `EMPLOYEE_AGENT.md`
3. 写入 `employee.json`
4. 初始化 `projects.json`
5. 创建项目目录
6. 写入 `runtime/meta.json`
7. 视开关决定是否生成 `AGENTS.md`

### 发布任务

1. 写入 `task_request.md`
2. 若有附件，写入 `references/`
3. 更新 `runtime/meta.json`
4. 更新 `projects.json`
5. 启动或切换 Codex 会话

### 启动会话

- 无任务：只进入工作目录
- 有任务：只把用户任务原文发给 Codex
- 有附件：只补附件文件路径

### 完成任务

1. 生成 `artifacts/completion_xxx.md`
2. 更新 `deliveries-index.json`
3. 更新 `runtime/meta.json`
4. 更新 `projects.json`
5. 如果存在排队项目，则切换项目指针

## 状态来源

### 运行状态

来自：

- live pty session
- `runtime/meta.json`

### 项目状态

来自：

- `projects.json`

状态集合：

- `idle`
- `assigned`
- `queued`
- `working`
- `blocked`
- `done`

### 成果状态

来自：

- `artifacts/`
- `deliveries-index.json`

## 当前设计原则

1. 不再把系统说明注入 Codex prompt
2. 不再强依赖 `startup_ack.md / plan.md / current.md` 这一套文件
3. 用旁路状态文件表达运行时，而不是要求 Codex 自报状态
4. 任务文件只保留用户原文
