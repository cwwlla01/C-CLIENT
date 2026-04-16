# Docker / Podman 运行说明

## 1. 目标

当前版本支持以“单容器 Supervisor”形式运行：

- 一个容器内同时运行：
  - Vite Preview UI
  - 本地 bridge
  - Codex CLI

这不是多 worker 分布式方案，而是本地单实例宿主容器化。

## 2. 前提

- 已安装 Docker 或 Podman
- 本机可联网安装依赖
- 容器内需要能执行 `codex`
- 若要直接复用本机 Codex 登录态，建议挂载 `~/.codex`

补充说明：

- Agent 仓库同步现在优先使用 GitHub 归档直连下载，不再为了“选择 Agent 定义”这一件事强依赖 `git`
- 但如果员工后续需要在任务里操作代码仓库，镜像里是否保留 `git` 仍然取决于你的实际工作流
- 首次启动引导里的 Codex 配置会写入容器内的 `~/.codex/config.toml` 和 `~/.codex/auth.json`
- 如果你挂载了宿主机的 `~/.codex`，那么容器内保存的 Codex 配置会直接落回宿主机

## 3. 构建镜像

当前 Dockerfile 已切换为多阶段构建：

- `builder`
  - 安装前端构建依赖
  - 产出 `dist/`
- `runtime`
  - 只保留运行所需文件与依赖
  - 继续保留 `codex`、`git`、`openssh-client`

这样做的目标是：

- 不把前端 devDependencies 带进最终镜像
- 不把源码和构建阶段缓存完整带进最终镜像
- 在保留当前功能的前提下先明显瘦身

当前实测：

- 旧单阶段镜像约 `1.05 GB`
- 新多阶段镜像约 `849 MB`

说明：

- 体积仍然不算小，主要因为运行镜像里依然保留了：
  - `codex`
  - `git`
  - `node-pty` 原生依赖
  - Alpine 上的构建工具链
- 如果后续要继续压缩，可以再拆出：
  - `full` 镜像：保留 `codex + git`
  - `slim` 镜像：只保留 UI + bridge

如果你准备把 bridge 暴露到非默认宿主机端口，比如 `4285:4281`，需要在构建阶段把这个宿主机端口写进前端。
否则浏览器里的 UI 仍然会去连接 `127.0.0.1:4281`，看起来就像“容器里读到了本地运行的数据”。

### Docker

```bash
docker build -t c-client:local .
```

### Podman

```bash
podman build -t c-client:local .
```

如果你要映射成 `4275/4285`：

```bash
podman build \
  --build-arg VITE_BRIDGE_HOST=127.0.0.1 \
  --build-arg VITE_BRIDGE_PORT=4285 \
  --build-arg VITE_DEFAULT_PROJECT_PATH=/workspace/company \
  -t c-client:local .
```

## 4. 直接运行

### Docker

```bash
docker run --rm -it \
  -p 4273:4273 \
  -p 4281:4281 \
  -e CCLIENT_BRIDGE_HOST=0.0.0.0 \
  -v %USERPROFILE%/.codex:/root/.codex \
  c-client:local
```

### Podman

```bash
podman run --rm -it \
  -p 4273:4273 \
  -p 4281:4281 \
  -e CCLIENT_BRIDGE_HOST=0.0.0.0 \
  -v %USERPROFILE%/.codex:/root/.codex \
  c-client:local
```

启动后：

- UI: `http://127.0.0.1:4273`
- bridge: `http://127.0.0.1:4281`

如果使用自定义宿主机端口，例如：

```bash
podman run --rm -it \
  -p 4275:4273 \
  -p 4285:4281 \
  -e CCLIENT_BRIDGE_HOST=0.0.0.0 \
  -v %USERPROFILE%/.codex:/root/.codex \
  c-client:local
```

则需要保证镜像构建时的 `VITE_BRIDGE_PORT=4285`，这样 `http://127.0.0.1:4275` 打开的页面才会连到容器的 bridge，而不是宿主机本地的 `4281`。

## 5. 使用 compose

```bash
docker compose up --build
```

或：

```bash
podman compose up --build
```

## 6. 目录挂载建议

当前 compose 示例预留了两个挂载目录：

- `./runtime-data/company -> /workspace/company`
- `./runtime-data/settings -> /workspace/settings`

说明：

- 员工项目空间、成果和队列建议放在容器外挂载目录中
- 这样容器重建后数据仍然保留

## 7. 当前限制

- 当前 UI 默认项目路径已支持通过构建参数预设，默认值为 `/workspace/company`
- `打开目录 / 打开文件` 这类动作在容器内只会尝试打开容器内部路径，不会直接调宿主机资源管理器
- 这更适合作为本地开发 / 演示部署，不是完整生产托管方案

## 8. 后续建议

如果后续要正式支持容器部署，建议继续补：

1. 容器内默认项目路径预设
2. 宿主机文件打开代理
3. API Key 与 Codex 登录态文档化
4. 多容器 worker 模式
