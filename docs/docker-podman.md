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

## 3. 构建镜像

### Docker

```bash
docker build -t c-client:local .
```

### Podman

```bash
podman build -t c-client:local .
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

- 当前 UI 默认项目路径仍需你在设置中手动调整到容器内路径
- `打开目录 / 打开文件` 这类动作在容器内只会尝试打开容器内部路径，不会直接调宿主机资源管理器
- 这更适合作为本地开发 / 演示部署，不是完整生产托管方案

## 8. 后续建议

如果后续要正式支持容器部署，建议继续补：

1. 容器内默认项目路径预设
2. 宿主机文件打开代理
3. API Key 与 Codex 登录态文档化
4. 多容器 worker 模式
