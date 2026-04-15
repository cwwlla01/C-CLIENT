# C-CLIENT

`C-CLIENT` 是员工 CLI Agent 的本地运行时宿主。

它不是业务决策中心。客户端负责：

- 基于公司、部门、成员、任务上下文初始化本地运行目录和任务空间
- 启动、停止、恢复员工 CLI 运行时
- 监控运行时健康度、Agent 身份、当前激活任务
- 对 UI 暴露统一的本地命令 / 事件接口
- 为后续服务端 WebSocket 通信复用同一套命令 / 事件模型

它不负责：

- CEO 到 leader 到员工的任务规划和逐级分发
- 组织与任务主数据的最终真相源
- 最终分配决策和全局调度

## 当前平台支持

- Windows：主支持平台
- Linux：理论可运行，待系统验收
- macOS：理论可运行，待系统验收
- iOS / Android：当前架构不支持

## 当前安全能力

- 支持可选开启的本地 API Key 鉴权
- 覆盖本地 REST 接口与 `/terminal` WebSocket
- 配置保存到 `{项目路径}/setting/security.json`

## 当前目录模型

当前客户端已经开始从“一个员工对应一个项目空间”过渡到“两层模型”：

1. 员工根目录
   - 保存员工画像、当前激活项目、跨项目队列、成果索引
2. 项目工作空间
   - 保存某个具体项目的 `current.md / plan.md / task_request.md / artifacts/`

这样做的目标是：

- 让不同项目上下文天然隔离
- 让工作成果在员工层聚合展示
- 为“当前项目完成后自动切到下一个项目”铺路

## 当前文档

- [MVP 当前版本说明](./docs/mvp-current-state.md)
- [本地 REST / WebSocket API](./docs/local-api-reference.md)
- [客户端运行时架构](./docs/client-runtime-architecture.md)
- [员工 Codex 运行时设计](./docs/employee-codex-runtime.md)
- [运行时协议](./docs/runtime-protocol.md)
- [UI 风格规范](./docs/ui-style-guide.md)

## 第一阶段目标

第一阶段先聚焦在一个可长期运行的本地 Supervisor：

1. UI 和运行时监督进程分离
2. 使用事件日志 + 状态快照，而不是 SQLite
3. 一个员工运行时从一个激活中的任务上下文恢复
4. 服务端轮询快照，并在重连后按事件增量补拉
5. 客户端只主动推送关键状态变化事件

## 本地运行

先安装依赖：

```bash
npm install
```

同时启动 UI 和本地 PTY bridge：

```bash
npm run dev:all
```

如果只想单独启动 bridge：

```bash
npm run bridge
```

默认端口：

- UI: `http://127.0.0.1:4273`
- PTY bridge: `http://127.0.0.1:4281`
