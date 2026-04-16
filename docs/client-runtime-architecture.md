# 客户端运行时架构

## 1. 目标

`C-CLIENT` 是员工 CLI Agent 的本地长期运行 Supervisor。

客户端需要在长时间运行下保持稳定，能够在 UI 重启后继续工作，在重新连上服务端后完成对账，并且能够从磁盘上的任务空间恢复员工运行时。

## 2. 职责边界

客户端负责：

- 初始化本地工作空间
- 管理员工 CLI 生命周期
- 监控运行时健康度
- 校验 Agent 身份
- 对 UI 暴露统一的本地命令 / 事件接口
- 为后续服务端通信提供 WebSocket 能力
- 基于任务空间完成本地恢复

客户端不负责：

- CEO -> leader -> 员工 的任务规划
- 公司级任务分发决策
- 组织与任务主数据的最终真相源
- 中心化权限与审计裁决

## 3. 长期运行的进程模型

建议拆成下面几层：

```text
Desktop UI
  -> Local API / Event Bus
    -> Supervisor Daemon
      -> CLI Runtime Workers
      -> Event Log + Snapshot Store
      -> Workspace Manager
      -> WebSocket Adapter
```

### 3.1 Supervisor Daemon

它是唯一的长期运行写入者，也是所有 CLI 子进程的拥有者。

职责：

- 统一管理 CLI 子进程生命周期
- 串行写入事件日志和状态快照
- 在重启后恢复运行时
- 协调本地 API 和 WebSocket 流量
- 执行健康检查与重启策略

### 3.2 Desktop UI

UI 只是监控与控制面板，不应该成为运行时所有者。

职责：

- 展示当前运行状态
- 展示员工与任务上下文
- 发送 `start`、`stop`、`restart`、`activate-task` 等命令
- 查看诊断信息与恢复历史

UI 崩溃或关闭时，Supervisor 和员工 CLI 应继续运行。

### 3.3 CLI Runtime Worker

一个员工对应一个运行时身份。

第一阶段建议：

- 一个员工只有一个主 CLI 运行时
- 一个运行时同一时间只激活一个任务上下文
- 队列中的任务和阻塞任务通过元数据维护

后续如果确实需要，再扩展成一个员工多个并发 session。

## 4. 工作空间模型

最清晰的模型是：

- 员工目录 = 身份容器
- 任务目录 = 真正的任务上下文空间
- runtime 元数据 = 当前激活任务与队列指针

建议目录：

```text
company/
  department/
    employee/
      profile.json
      agent.json
      runtime/
        current_task.json
        queue.json
      tasks/
        task-001/
          task.json
          plan.md
          current.md
          wait_finished.md
          finished.md
          block.md
          artifacts/
        task-002/
          ...
```

### 4.1 为什么任务目录才是真正的上下文边界

如果把多个任务都堆在员工目录下，员工任务一多就会出现上下文污染，恢复规则也会变得模糊。

一个任务一个目录的好处：

- 上下文隔离更干净
- 重启和恢复更简单
- token 消耗更可控，因为只需要装载一个激活任务
- 以后任务重新分配给其他员工更容易迁移

### 4.2 人类可读文件与机器可读文件

Markdown 文件给人和 Agent 阅读：

- `plan.md`
- `current.md`
- `wait_finished.md`
- `finished.md`
- `block.md`

结构化 JSON 给 Supervisor 做确定性恢复：

- `task.json` 是任务元数据来源
- `current_task.json` 指明当前应该激活哪个任务
- `queue.json` 保存排队和阻塞任务 id

恢复流程不能依赖解析 Markdown 作为真相源。

## 4.3 员工运行时的真正定义

员工不应该被建模成一个普通 shell 或裸 PTY。

更合理的定义是：

- 员工 = 项目空间 + Agent 定义快照 + 被正确初始化的 Codex CLI 会话

这意味着后续客户端在启动员工 CLI 时，不应该只做：

- 打开一个 shell

而应该做：

1. 进入员工项目空间
2. 确保 `AGENTS.md` 已位于当前项目空间
3. 读取 `ROLE.md`
4. 读取 `current.md` 与 `plan.md`
5. 用这些上下文初始化 Codex

只有这样，员工才真正是“应用了 Agent 的执行单元”，而不是一个没有身份约束的终端。

## 4.4 项目空间内的工作说明书

建议每个员工项目空间都包含：

- `AGENTS.md`
- `workspace_guide.md`

同时建议在项目根目录保留模板源：

- `{项目路径}/setting/templates/AGENTS.md`

项目空间初始化时将它复制为当前工作空间的 `AGENTS.md`，这样无论员工实际工作目录如何变化，Codex 都能在该工作空间内读取到长期规则。

作用：

- `AGENTS.md`
  - 让 Codex 在进入项目空间时自动加载长期规则
  - 约束这些任务文件应如何被维护
  - 明确产出物、阻塞记录和计划更新的基本规范

- `workspace_guide.md`
  - 作为给人类或调试场景阅读的补充说明
  - 告诉阅读者这些文件分别代表什么
  - 说明哪些文件是业务上下文，哪些文件是运行时元数据

它和 `ROLE.md` 的区别：

- `ROLE.md` 说明“你是谁”
- `AGENTS.md` 说明“你必须怎么工作”
- `workspace_guide.md` 说明“这些文件分别是什么意思”

这套结构当前已经做过真实验证：

- 在临时工作空间中写入特征化 `AGENTS.md`
- 使用 `codex exec -C {workspace}` 直接提问
- Codex 能返回只有该 `AGENTS.md` 中才有的验证 token

## 5. 持久化模型

第一阶段不使用 SQLite。

改用：

- append-only 事件日志
- 当前状态快照
- 可选的本地诊断日志

这是一个轻量日志驱动模型，借鉴日志系统思路，但不引入完整 Kafka 复杂度。

建议运行时存储：

```text
.duanju/
  runtimes/
    emp-7/
      events.ndjson
      snapshot.json
      current_task.json
```

### 5.1 事件日志

`events.ndjson` 用 append-only 方式记录关键运行时状态变化。

用途：

- 本地恢复历史
- 重连后的增量同步
- 诊断排错
- 服务端按事件增量拉取

不用于保存高频终端原始输出。

### 5.2 状态快照

`snapshot.json` 保存单个员工运行时的最新有效状态。

用途：

- UI 读取
- 服务端轮询
- 客户端快速启动，而不是每次都重放完整事件日志

### 5.3 单写者原则

只有 Supervisor 可以写：

- 事件日志
- 状态快照
- 恢复元数据

UI、WebSocket 处理器、进程回调都只能把变化路由给 Supervisor，由它统一落盘。

这能去掉大多数本地一致性问题。

## 6. 健康模型

不要把运行时健康度压缩成单一的在线 / 离线布尔值。

至少拆成四个维度：

- `process_state`: `starting | alive | exited | crashed`
- `agent_state`: `matched | mismatched | unverified`
- `health_state`: `healthy | degraded | timeout`
- `work_state`: `idle | busy | blocked | suspended`

这样才能区分：

- 进程还活着，但没有心跳
- 进程还活着，但 Agent 不匹配
- 进程健康，但当前任务阻塞

## 7. 恢复模型

客户端重启或重新连接服务端时：

1. 读取员工运行时最新快照
2. 检查目标 CLI 进程是否还存在
3. 校验握手结果和 Agent 身份
4. 如果进程不存在或身份无效，读取 `current_task.json`
5. 定位激活任务目录
6. 基于 `task.json` 和最小任务状态重建上下文
7. 重启 CLI 并写入恢复事件

### 7.1 一个重要约束

不要尝试恢复无限增长的完整对话历史。

恢复的是结构化工作状态：

- 当前任务 id
- 任务摘要
- 下一步动作
- 阻塞原因
- 待执行任务队列

这样恢复才稳定，token 成本也可控。

## 8. 服务端交互模型

本地 UI 和未来 WebSocket 都必须共用同一套命令 / 事件模型。

变化的是传输方式，不是消息结构。

建议策略：

- 服务端通过 API 轮询快照状态
- 客户端只主动推送关键状态变化
- 服务端可基于 `event_id` 拉取增量事件

这样既有可观测性，也不会出现高频主动推送。

## 9. 长期运行必须具备的约束

如果要长期稳定运行，第一版必须具备：

- Supervisor 与 UI 分离
- 任务目录级别的上下文隔离
- append-only 事件日志
- 基于快照的当前状态读取
- 结构化恢复元数据
- 显式重启策略
- Agent 握手与身份校验
- 按事件增量同步

缺少这些约束，客户端在长时间运行后会越来越难恢复，也越来越难排错。

## 10. 第一阶段实现范围

第一版稳定实现建议包含：

1. Supervisor 守护进程
2. 员工运行时快照和事件日志
3. 基于 `current_task.json` 的任务激活
4. CLI 的启动、停止、重启、恢复
5. Agent 握手与身份校验
6. 供 UI 使用的本地 API
7. 协议兼容但实现可空的 WebSocket 适配器

第一版不急着做：

- 一个员工多个并发 session
- 完整业务分发逻辑
- 大量终端日志持久化
- 复杂归档策略
- 多客户端之间的复杂分布式协调
