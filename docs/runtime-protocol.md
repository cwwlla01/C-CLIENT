# 运行时协议

## 1. 协议设计原则

本地 API 和未来 WebSocket 接口必须共用同一套命令 / 事件模型。

变化的是传输层：

- 本地传输用于 UI -> Supervisor 调用
- WebSocket 传输用于 服务端 -> Supervisor 调用

消息体结构保持一致。

## 2. Snapshot 结构

每个员工运行时都应该暴露一个当前快照。

示例：

```json
{
  "client_id": "client-shanghai-01",
  "updated_at": "2026-04-12T15:15:00+08:00",
  "last_event_id": "evt-20260412-000130",
  "employee": {
    "company_id": "company-3",
    "department_id": "dept-2",
    "employee_id": "emp-7",
    "name": "员工7"
  },
  "runtime": {
    "desired_state": "running",
    "session_state": "alive",
    "health_state": "healthy",
    "agent_state": "matched",
    "work_state": "busy",
    "current_task_id": "task-001",
    "queued_task_ids": [
      "task-002"
    ],
    "blocked_task_ids": [
      "task-003"
    ],
    "pid": 8124,
    "session_id": "sess-abc123",
    "started_at": "2026-04-12T15:12:00+08:00",
    "last_heartbeat_at": "2026-04-12T15:14:58+08:00",
    "restart_count": 1,
    "workspace": "D:/PROJECT/company-3/dept-2/emp-7/tasks/task-001"
  },
  "agent": {
    "source_type": "github",
    "source": "https://github.com/org/repo",
    "ref": "a1b2c3d4",
    "entry": "roles/frontend/ROLE.md",
    "fingerprint": "sha256:xxxx"
  },
  "restore": {
    "last_restore_at": "2026-04-12T15:12:01+08:00",
    "last_restore_result": "success",
    "last_restore_error": ""
  }
}
```

### 2.1 推荐枚举

`desired_state`

- `running`
- `stopped`

`session_state`

- `starting`
- `alive`
- `exited`
- `crashed`

`health_state`

- `healthy`
- `degraded`
- `timeout`

`agent_state`

- `matched`
- `mismatched`
- `unverified`

`work_state`

- `idle`
- `busy`
- `blocked`
- `suspended`

## 3. 事件日志结构

`events.ndjson` 中每一行都是一个完整 JSON 事件。

示例：

```json
{
  "event_id": "evt-20260412-000123",
  "time": "2026-04-12T15:12:03+08:00",
  "type": "runtime.session.started",
  "client_id": "client-shanghai-01",
  "company_id": "company-3",
  "department_id": "dept-2",
  "employee_id": "emp-7",
  "task_id": "task-001",
  "session_id": "sess-abc123",
  "payload": {
    "pid": 8124,
    "workspace": "D:/PROJECT/company-3/dept-2/emp-7/tasks/task-001"
  }
}
```

### 3.1 事件设计规则

- append only
- 一行一条事件
- 不做原地修改
- 每条事件必须有唯一 `event_id`
- 每条事件都必须能定位到某个员工运行时

### 3.2 必要事件类型

- `client.started`
- `client.reconnected`
- `runtime.session.started`
- `runtime.session.exited`
- `runtime.session.restart_scheduled`
- `runtime.session.restarted`
- `runtime.agent.matched`
- `runtime.agent.mismatched`
- `runtime.task.activated`
- `runtime.restore.succeeded`
- `runtime.restore.failed`
- `runtime.health.degraded`
- `runtime.health.recovered`

## 4. 本地命令模型

UI 通过本地命令调用 Supervisor，后续同一份 payload 直接复用到 WebSocket 请求。

第一版命令集合：

- `runtime.get_client_health`
- `runtime.get_employee_snapshot`
- `runtime.get_events_since`
- `runtime.start_session`
- `runtime.stop_session`
- `runtime.restart_session`
- `runtime.activate_task`
- `runtime.verify_agent`
- `runtime.reconcile_employee`

### 4.1 命令示例

`runtime.get_employee_snapshot`

```json
{
  "command": "runtime.get_employee_snapshot",
  "payload": {
    "company_id": "company-3",
    "department_id": "dept-2",
    "employee_id": "emp-7"
  }
}
```

`runtime.activate_task`

```json
{
  "command": "runtime.activate_task",
  "payload": {
    "company_id": "company-3",
    "department_id": "dept-2",
    "employee_id": "emp-7",
    "task_id": "task-002"
  }
}
```

## 5. 服务端轮询模型

服务端不能只依赖客户端主动推送。

建议方式：

- 服务端定时轮询快照
- 服务端在重连后拉取增量事件
- 客户端只主动推送关键状态变化

### 5.1 轮询接口

`runtime.get_client_health`

返回客户端级别健康摘要：

```json
{
  "client_id": "client-shanghai-01",
  "connected": true,
  "updated_at": "2026-04-12T15:15:00+08:00",
  "runtime_count": 12,
  "alive_count": 10,
  "degraded_count": 1,
  "mismatch_count": 1
}
```

`runtime.get_employee_snapshot`

返回单个员工当前运行时快照。

`runtime.get_events_since`

输入：

```json
{
  "command": "runtime.get_events_since",
  "payload": {
    "employee_id": "emp-7",
    "since_event_id": "evt-20260412-000120",
    "limit": 100
  }
}
```

输出：

```json
{
  "events": [
    {
      "event_id": "evt-20260412-000121",
      "type": "runtime.session.exited"
    },
    {
      "event_id": "evt-20260412-000122",
      "type": "runtime.session.restarted"
    }
  ],
  "has_more": false
}
```

## 6. 客户端主动推送规则

为了保持轻量，客户端不主动高频推送 heartbeat。

客户端只主动推送这些关键变化：

- `runtime.session.started`
- `runtime.session.exited`
- `runtime.session.restarted`
- `runtime.agent.mismatched`
- `runtime.task.activated`
- `runtime.restore.failed`

其余信息由服务端通过轮询快照或增量事件拉取获得。

## 7. 重连同步流程

客户端重新连上服务端后：

1. 服务端先拿客户端健康摘要
2. 服务端再拿关心的员工快照
3. 服务端根据已知 `event_id` 拉后续增量事件
4. 客户端从 `events.ndjson` 返回事件
5. 如果服务端发现某员工运行时缺失，再发 reconcile 或 start 命令

## 8. Event ID 生成规则

第一版可以直接使用：

- 时间戳前缀
- 本地递增序号后缀

示例：

- `evt-20260412-000001`
- `evt-20260412-000002`

对于单写者 Supervisor，这个规则已经够用。

## 9. 文件轮转

第一版先保持简单：

- `events.ndjson` 超过 10 MB 就切分
- `snapshot.json` 始终只保留最新状态
- 老事件是否 compact，放到后续安全同步能力之后再做
