# 员工 Codex 运行时设计

## 1. 设计结论

真正的员工不应该被定义为一个普通 shell 或裸 PTY。

真正的员工应该被定义为：

- 一个独立项目空间
- 一份固定的 `ROLE.md` 角色定义快照
- 一份项目空间级 `AGENTS.md` 长期规则
- 一次被正确初始化的 Codex CLI 会话
- 一套明确的文件更新约定

换句话说，员工本质上是“应用了 Agent 的 Codex CLI 窗口”。

## 2. 为什么不能把员工等同于普通 CLI

如果员工只是一个普通终端，会出现几个问题：

- 会话启动后没有角色身份
- 不知道当前项目空间里的文件分别代表什么
- 恢复时无法稳定装载上下文
- 文件更新没有统一规则
- 同一个员工在不同任务中会出现行为漂移

所以客户端的长期方向不应该是“启动一个 shell”，而应该是“启动一个带角色、规则和上下文的 Codex 员工会话”。

## 3. 建议启动流程

客户端后续在启动员工 CLI 时，建议按下面顺序执行：

1. 进入员工项目空间目录
2. 确认以下文件存在：
   - `AGENTS.md`
   - `ROLE.md`
   - `workspace_guide.md`
   - `task_request.md`
   - `startup_ack.md`
   - `plan.md`
   - `current.md`
   - `wait_finished.md`
   - `finished.md`
   - `block.md`
   - `runtime/meta.json`
3. 启动 Codex CLI
4. 在初始化阶段向 Codex 明确注入：
   - 员工身份来自 `ROLE.md`
   - 长期工作规则来自 `AGENTS.md`
   - 原始需求优先从 `task_request.md` 读取
   - 恢复摘要从 `restore_summary.md` 补充

## 4. 文件语义

### 员工根目录与项目工作空间

从当前版本开始，员工与项目不再建议绑定成同一个长期目录。

建议结构：

- 员工根目录
  - `ROLE.md`
  - `employee.json`
  - `current-project.json`
  - `dispatch-queue.json`
  - `deliveries-index.json`
- 项目工作空间
  - `projects/<project>/AGENTS.md`
  - `projects/<project>/ROLE.md`
  - `projects/<project>/current.md`
  - `projects/<project>/plan.md`
  - `projects/<project>/task_request.md`
  - `projects/<project>/artifacts/`

当前实现仍保持“员工目录下直接挂项目目录”的兼容结构，但已经开始补齐以下员工根目录元数据：

- `current-project.json`
  当前激活项目指针
- `dispatch-queue.json`
  跨项目待切换队列
- `deliveries-index.json`
  员工级成果索引
- `employee.json`
  员工画像与默认运行配置

这样做的目的是：

- 把项目上下文隔离开
- 避免不同项目共用一个无限膨胀的工作空间
- 让客户端后续能在员工层聚合展示“工作成果”和“待切换项目”

### `ROLE.md`

员工角色定义快照。

作用：

- 定义员工是谁
- 定义能力边界、语气、职责
- 为 Codex 会话提供稳定角色输入

### `AGENTS.md`

项目空间级长期规则文件。

作用：

- 让 Codex 在进入项目空间时自动加载工作规则
- 约束任务文件和产出物应如何维护
- 作为长期稳定规则，而不是当次任务说明

模板来源：

- `{项目路径}/setting/templates/AGENTS.md`

初始化项目空间时，客户端会自动把模板复制到：

- `{workspace}/AGENTS.md`

### `workspace_guide.md`

项目空间工作说明书。

作用：

- 解释各文件分别代表什么
- 告诉员工应如何更新这些文件
- 告诉员工哪些文件是业务文件，哪些文件是运行时元数据

### `task_request.md`

原始任务收件箱。

作用：

- 保存外部投递给员工的原始需求
- 作为员工生成 `plan.md` 的起点
- 避免客户端越权替员工预写执行计划

### `references/`

任务附带的参考资料目录。

作用：

- 保存任务附带的图片、文档、代码片段等输入材料
- 作为 `task_request.md` 的补充参考来源
- 对新启动的 Codex 会话，图片资料可作为启动时的图片输入

### `startup_ack.md`

首轮确认文件。

作用：

- 员工启动后确认自己已经读取任务
- 记录是否已经生成计划
- 记录员工理解摘要与下一步动作
- 为 UI 展示“待确认 / 已确认 / 已出计划”提供依据

### `plan.md`

任务拆解计划。

作用：

- 记录收到任务后的执行规划
- 记录依赖、风险、拆解步骤

### `current.md`

当前执行项。

作用：

- 记录员工此刻正在做什么
- 作为恢复时优先读取的业务上下文

### `wait_finished.md`

待执行任务队列。

### `finished.md`

已完成事项与结果摘要。

### `block.md`

阻塞项与需要的支持。

### `artifacts/`

真实产出物目录。

### `runtime/meta.json`

客户端与服务端使用的运行时元数据，不是业务文件。

## 5. 文件更新规则

### 接到新任务时

1. 先阅读 `task_request.md`
2. 先更新 `startup_ack.md`
3. 再生成或更新 `plan.md`
4. 然后更新 `current.md`
5. 如果存在未开始事项，写入 `wait_finished.md`

### 执行过程中

1. 任务切换时更新 `current.md`
2. 阻塞出现时更新 `block.md`
3. 产出物写入 `artifacts/`

### 任务完成时

1. 将摘要追加到 `finished.md`
2. 将真实产出放入 `artifacts/`
3. 清理或重写 `current.md`

## 6. 恢复策略

恢复时不应该依赖无限增长的完整对话历史。

建议恢复顺序：

1. 先读 `task_request.md`
2. 再读 `restore_summary.md`
3. 然后结合 `current.md`、`plan.md`、`block.md`、`wait_finished.md`、`finished.md`
4. 最后再参考 `runtime/meta.json`

恢复的是结构化工作状态，而不是完整聊天记录。

## 7. 当前实现状态

当前客户端已经具备以下基础能力：

- 创建员工项目空间
- 写入 `ROLE.md`
- 初始化项目空间时复制 `AGENTS.md`
- 写入 `plan.md`
- 写入 `workspace_guide.md`
- 写入 `task_request.md`
- 写入 `startup_ack.md`
- 写入 `codex_bootstrap.md`
- 写入 `restore_summary.md`
- 写入 `current.md`、`wait_finished.md`、`finished.md`、`block.md`
- 启动、停止、重启本地 CLI 运行时
- 当本机存在 `codex` 且项目空间文件齐备时，优先以 Codex CLI 方式启动员工会话
- 在 `startup_ack.md` 处于待确认时，启动后会后台尝试执行一次轻量 Codex 首轮确认
- 已通过真实 `codex exec` 验证项目空间内的 `AGENTS.md` 会生效

当前仍未完全实现的部分：

- 更丰富的初始化 prompt 组装策略
- 启动后首轮任务摘要与恢复确认机制
- 基于 `current.md` / `plan.md` 的标准化恢复 prompt 版本化

## 8. 下一步建议

1. 客户端把员工启动命令从普通 shell 启动切换为 Codex 启动
2. 生成并注入标准初始化 prompt
3. 将 `current.md` / `plan.md` 作为恢复入口固定下来
4. 为 UI 增加 `plan.md` 与 `workspace_guide.md` 快捷打开入口
