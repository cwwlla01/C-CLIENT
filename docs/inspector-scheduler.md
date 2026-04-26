# InspectorScheduler 设计稿

## 定位

`InspectorScheduler` 是客户端内部的异步观察者服务。

它不是员工，不出现在组织架构里，不参与业务分发，只负责：

- 观察员工 CLI 输出与静默状态
- 判断是否进入 `waiting_feedback / blocked`
- 生成建议
- 在自动驾驶开启时对白名单问题自动回复

## 决策分层

### 第一层：规则引擎

默认模式，不调 AI。

输入：

- 最近终端输出
- 最近输出时间
- 是否回到输入态
- 最近文件变化
- `task_request.md`
- `runtime/meta.json`

输出：

- `taskState`
- `verdict`
- `confidence`
- `ruleMatches`
- `suggestions`
- `replyCandidate`

### 第二层：AI 兜底

仅在：

- `inspectionMode = hybrid | ai_only`
- 规则置信度不足
- 风险不是高危

时才调用独立的 Inspector API。

## 自动驾驶模式

支持：

- `off`
- `suggest_only`
- `safe_auto`
- `full_auto`

说明：

- `off`：不自动回复
- `suggest_only`：只建议，用户确认后发送
- `safe_auto`：只对白名单低风险问题自动回复
- `full_auto`：允许处理更多中风险问题

## 配置文件

路径：

```text
{projectRoot}/setting/inspector.json
```

当前配置项：

- 是否启用观察者
- 检查模式
- 自动驾驶模式
- 自动回复开关
- 高风险人工确认
- 阈值
- 回复偏好
- 独立 Inspector AI 配置

## 当前实现范围

本阶段已落地：

- `inspector.json` 配置文件读写接口
- 设置页“观察者配置”tab
- 规则参数与自动驾驶参数存储
- `POST /api/settings/inspector/test`
- `POST /api/inspector/review`
- `POST /api/inspector/reply`
- `runtime/inspector-last.json`
- 观察结果在员工详情展示
- 观察者建议进入审核消息
- `safe_auto / full_auto` 起步版自动回复

## 当前观察结果字段

当前 `runtime/inspector-last.json` 主要包含：

- `taskState`
- `verdict`
- `confidence`
- `summary`
- `ruleMatches`
- `risks`
- `suggestions`
- `replyCandidate`
- `targetFiles`
- `matchedTargetFiles`
- `missingTargetFiles`
- `lastSilenceSeconds`
- `aiUsed`
- `aiError`
- `autoPilotDecision`
- `lastAutoReplyAt`

## 当前结果来源说明

UI 中现在会直接标识结果来源：

- `规则`
- `规则 + 自动驾驶`
- `规则 + AI`
- `规则 + AI + 自动驾驶`

本阶段未落地：

- 更细粒度的 AI 评审合并策略
- 更细的高风险分类
