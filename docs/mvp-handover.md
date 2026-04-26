# MVP 交接说明

## 当前实现结论

本版本已经从“重 markdown 工作流”切到“轻运行时宿主”模型。

## 交接重点

### 1. 任务直达 Codex

- 系统不再发送解释性 prompt
- 有任务时只发送用户原文
- 有附件时只补文件路径

### 2. 状态旁路化

- 运行态：`runtime/meta.json`
- 项目态：`projects.json`
- 成果态：`deliveries-index.json`

### 3. 旧流程退出主链路

以下文件不再是主流程必需项：

- `startup_ack.md`
- `plan.md`
- `current.md`
- `wait_finished.md`
- `finished.md`
- `block.md`
- `restore_summary.md`

## 当前仍然需要关注

1. 文档是否完全同步
2. 前端展示是否完全转到新状态模型
3. 是否继续删除 bridge 内剩余兼容函数

## 建议交接后第一步

1. 跑一次 `npm run build`
2. 启动本地 bridge / UI
3. 实测：
   - 新增员工
   - 发布任务
   - 启动终端
   - 完成任务
4. 核对：
   - `task_request.md`
   - `runtime/meta.json`
   - `projects.json`
   - `deliveries-index.json`
