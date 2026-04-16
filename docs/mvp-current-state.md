# MVP 当前版本说明

## 1. 版本定位

当前版本是 `C-CLIENT` 的本地 Supervisor MVP。

它的目标不是完成 CEO -> leader -> 员工 的全链路调度，而是先把“员工 CLI 宿主 + 项目空间 + 本地监督面板”做成一套能长期运行、可恢复、可演示的基础版本。

当前版本更适合作为：

- 本地员工运行时管理器
- 多项目工作空间宿主
- 员工级成果聚合视图
- 后续服务端接管前的本地控制面板

## 2. 已实现能力

### 2.1 员工与项目空间

- 创建员工
- 删除员工
- 初始化员工项目空间
- 写入 `AGENTS.md`、`ROLE.md`、`workspace_guide.md`、`task_request.md`、`startup_ack.md`、`plan.md`、`current.md`、`wait_finished.md`、`finished.md`、`block.md`
- 自动维护模板：
  - `{项目路径}/setting/templates/AGENTS.md`
- 建立员工根目录元数据：
  - `employee.json`
  - `current-project.json`
  - `dispatch-queue.json`
  - `deliveries-index.json`

### 2.2 CLI 运行时管理

- 启动 CLI
- 停止 CLI
- 重启 CLI
- 恢复已存在员工工作空间
- 以 Codex 模式优先启动员工会话
- 启动时自动生成 `restore_summary.md` 与 `codex_bootstrap.md`
- 启动前自动确保项目空间内存在 `AGENTS.md + ROLE.md`
- 已通过真实 `codex exec` 验证项目空间内的 `AGENTS.md` 会被加载

### 2.3 任务流转

- 发布原始需求到员工
- 发布任务时支持附带文件、图片等参考资料
- 任务优先级 / 时间窗口 / 指派来源
- 同项目直接分配
- 跨项目分配
  - 可立即切项目时直接切换工作空间
  - 当前项目未完成时进入员工级切换队列
- 完成任务后自动归档
- 若员工级切换队列存在下一个项目，则自动切到目标项目
- 参考资料会保存到项目空间的 `references/`

### 2.4 监督 UI

- 运行终端画布
- 首次启动引导
  - 配置 Codex
  - 创建第一个员工
  - 发布第一条任务
- 公司筛选
- 运行状态筛选
- 员工详情弹窗 4 个视角：
  - 员工信息
  - 运行情况
  - 工作成果
  - 项目空间
- 内置终端窗口
- 设置弹窗
- 审核消息中心

### 2.5 成果聚合

- 员工级工作成果聚合
- 默认按项目分组展示
- 优先读取 `deliveries-index.json`
- 若索引为空，则回退扫描员工名下所有项目目录
- 支持下载：
  - 单个交付物文件
  - 单项目成果包
  - 员工全部成果包

### 2.6 提示自动化

- 员工级运行策略
  - 权限模式
  - 提示自动化
  - 提权处理
  - 自动信任工作空间
- 系统内置自动处理：
  - Codex 工作目录信任提示
  - `Press enter to continue`
- 提权提示集中进入“审核消息”
- 提示白名单
  - 保存到 `{项目路径}/setting/prompt-rules.json`
  - 第一版只支持“文本包含 -> 固定回复”

### 2.7 本地接口鉴权

- 支持可选开启的 API Key 鉴权
- 设置页可配置：
  - 是否启用
  - API Key
  - 生成新 Key
- 配置落到 `{项目路径}/setting/security.json`
- 作用范围：
  - 本地 REST API
  - 本地 `/terminal` WebSocket

### 2.8 Codex 配置

- 设置页新增 `Codex 配置` tab
- 首次启动自动弹出引导
- 支持表单配置：
  - `model_provider`
  - `model`
  - `review_model`
  - `model_reasoning_effort`
  - `disable_response_storage`
  - `network_access`
  - `windows_wsl_setup_acknowledged`
  - `model_context_window`
  - `model_auto_compact_token_limit`
  - `[model_providers.custom]`
  - `OPENAI_API_KEY`
  - `auth_mode`
- 支持 `config.toml` 源文件编辑模式
- 支持连通性测试
- 默认写入：
  - `{CODEX_HOME}/config.toml`
  - `{CODEX_HOME}/auth.json`
  - 未设置时使用 `~/.codex`

## 3. 当前 UI 结构

### 3.1 顶部导航

- 公司筛选
- 审核消息
- 发布任务
- 添加员工
- 扫描员工
- 设置
- 设置菜单中可重新打开“首次引导”

### 3.2 员工卡片

卡片只保留决策需要的信息：

- 姓名 / 公司 / 角色 / 编号
- 主运行状态
- 当前任务
- 下一步
- 最近完成 / 最近交付物

卡片不展示：

- 会话接单阶段标签
- sessionId / pid
- 项目名

### 3.3 员工详情

#### 员工信息

- 身份档案
- 当前空间
- 常用入口
- 运行策略

#### 运行情况

- 会话摘要
- 当前任务
- 风险与阻塞
- 技术详情

#### 工作成果

- 员工级聚合成果
- 按项目分组

#### 项目空间

- 员工名下全部项目空间
- 当前项目 / 排队中 / 阻塞 / 空闲

## 4. 当前目录模型

当前实现采用“两层模型”：

### 员工根目录

用于保存员工级长期元数据：

- `ROLE.md`
- `employee.json`
- `current-project.json`
- `dispatch-queue.json`
- `deliveries-index.json`

### 项目工作空间

每个项目是一个独立工作空间：

- `<project>/AGENTS.md`
- `<project>/ROLE.md`
- `<project>/current.md`
- `<project>/plan.md`
- `<project>/task_request.md`
- `<project>/startup_ack.md`
- `<project>/finished.md`
- `<project>/artifacts/`

## 5. 当前边界

客户端当前负责：

- 初始化本地目录
- 管理员工 CLI 生命周期
- 恢复与监督员工运行时
- 展示项目空间、成果和审核消息
- 提供本地 REST / WebSocket 接口
- 对外提供员工维度查询接口（信息 / 状态 / 任务 / 项目 / 交付物）

客户端当前不负责：

- CEO / leader / 员工 的组织级任务决策
- 服务端主数据真相源
- 中心化权限审计
- 远程多客户端协调

## 6. 当前已知限制

- 服务端还未真正接入，目前以本地 bridge 为主
- Codex 连通性测试当前只验证 `{baseUrl}/models`，不代表完整执行链路一定全部可用
- “项目空间” tab 当前只支持打开目录，尚未支持“直接切到该项目”
- `deliveries-index.json` 会持续被新完成任务补齐；历史老项目目前依赖回退扫描
- 提示白名单第一版只支持文本包含，不支持正则、优先级和作用域
- 审核消息当前是本地内存态，重启 bridge 后最近处理日志不会持久化
- 一个员工当前仍只维护一个主 CLI 会话，不支持多项目并发会话

## 7. 平台支持矩阵

### Windows

- 当前主支持平台
- 已完成主要开发与联调验证
- `PowerShell / pwsh / codex / 本地目录打开 / node-pty` 均按 Windows 路径和行为优先适配

### Linux

- 架构上可运行
- 前端、Node.js、`ws`、`node-pty`、`xdg-open` 都有对应支持
- 但当前版本未做系统验收

当前 Linux 待重点验证：

- `codex` 启动链路
- PTY 输入输出稳定性
- 不同 shell 环境下的路径与权限行为
- 长时间运行后的恢复与重启表现

### macOS

- 架构上大概率可运行
- 本地路径打开已有 `open` 分支
- 但当前版本同样未做系统验收

### iOS / Android

- 当前架构下不支持
- 原因：
  - 依赖 Node.js 本地进程
  - 依赖 `node-pty`
  - 依赖本地 CLI / Codex
  - 依赖桌面级文件系统与本地 bridge

## 8. 下一步建议

建议按下面顺序继续推进：

1. 工作成果增加“全部项目 / 当前项目 / 指定项目”筛选
2. 项目空间 tab 增加“切到该项目”
3. 审核消息日志持久化
4. 提示白名单支持作用域和优先级
5. 服务端接入真实同步协议
