# Docker / Podman 运行说明

## 1. 目标

当前版本支持以“单容器 Supervisor”形式运行：

- 一个容器内同时运行：
  - 静态 UI Server
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

## 2.1 `.env` 说明

项目根目录现在提供：

- `.env.example`

推荐做法：

```bash
cp .env.example .env
```

说明：

- `docker compose` 会自动读取根目录 `.env`
- `bridge/server.mjs` 和 `bridge/container-entry.mjs` 也会自动读取根目录 `.env`
- `VITE_*` 变量仍然按 Vite 的原生规则生效
- 如果同一个变量既在 shell 中显式导出，又写在 `.env`，通常以当前进程环境变量为准

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
- 新多阶段镜像约 `473 MB`

说明：

- 体积仍然不算小，主要因为运行镜像里依然保留了：
  - `codex`
  - `git`
  - `node-pty` 原生依赖
  - Node 运行时与前端静态资源
- 如果后续要继续压缩，可以再拆出：
  - `full` 镜像：保留 `codex + git`
  - `slim` 镜像：只保留 UI + bridge

前端现在支持容器启动时动态读取 `/runtime-config.js`。
也就是说：

- bridge 地址优先走容器启动时的环境变量
- 没显式配置时，默认跟随浏览器当前访问的域名
- 不再要求为了改 bridge 地址重新 `docker build`

### Docker

```bash
docker build -t c-client:local .
```

### Podman

```bash
podman build -t c-client:local .
```

如果你只是正常构建：

```bash
podman build -t c-client:local .
```

如果你想预设容器里的默认项目路径，也仍然可以保留：

```bash
podman build \
  --build-arg VITE_DEFAULT_PROJECT_PATH=/workspace/company \
  -t c-client:local .
```

### 构建阶段配置项说明

- `VITE_DEFAULT_PROJECT_PATH`
  - 作用：给前端写入一个“默认项目路径”兜底值。
  - 典型场景：你希望容器初次启动时，设置页和工作空间扫描默认指向 `/workspace/company`。
  - 注意：这属于构建阶段默认值。容器启动后如果同时传了 `CCLIENT_PUBLIC_DEFAULT_PROJECT_PATH`，则以启动时环境变量为准。
- `VITE_BRIDGE_HOST`
  - 作用：前端构建阶段的 bridge host 兜底值。
  - 典型场景：主要用于非常固定的部署环境，或者没有启用运行时 `/runtime-config.js` 时的兼容兜底。
  - 当前建议：一般不需要再主动设置，优先用容器启动时的 `CCLIENT_PUBLIC_*`。
- `VITE_BRIDGE_PORT`
  - 作用：前端构建阶段的 bridge 端口兜底值。
  - 默认值：`4281`
  - 当前建议：只有在你确实希望保留构建时端口兜底时才设置；多数情况下优先用 `CCLIENT_PUBLIC_BRIDGE_PORT` 或完整的 `CCLIENT_PUBLIC_BRIDGE_ORIGIN`。
- `VITE_BRIDGE_ORIGIN`
  - 作用：前端构建阶段写死 HTTP bridge 地址，例如 `http://host:4281`。
  - 当前建议：除非你明确要做“构建一次、固定部署到单一地址”的镜像，否则不建议优先依赖它。
- `VITE_BRIDGE_WS_ORIGIN`
  - 作用：前端构建阶段写死 WebSocket bridge 地址，例如 `ws://host:4281`。
  - 当前建议：和 `VITE_BRIDGE_ORIGIN` 一样，更推荐作为兼容兜底，而不是主配置入口。

## 4. 直接运行

说明：

- `-v ...:/root/.codex` 是可选挂载；不挂载也能启动，但容器删除后 Codex 配置不会保留
- `%USERPROFILE%` 只适用于 Windows `cmd.exe`
- 如果你是在 Linux / macOS / Git Bash / 远程 Linux 服务器里执行 `docker run`，请改用 `$HOME` 或绝对路径
- 例如你当前是 `root@...` 这样的 Linux shell，就应该写成 `/root/.codex:/root/.codex`
- 下面这组环境变量可以在容器启动时直接覆盖前端 bridge 配置：
  - `CCLIENT_PUBLIC_BRIDGE_ORIGIN`
  - `CCLIENT_PUBLIC_BRIDGE_WS_ORIGIN`
  - `CCLIENT_PUBLIC_BRIDGE_HOST`
  - `CCLIENT_PUBLIC_BRIDGE_PORT`
  - `CCLIENT_PUBLIC_DEFAULT_PROJECT_PATH`

### 运行时配置项说明

#### Bridge 进程自身配置

- `CCLIENT_BRIDGE_HOST`
  - 作用：控制 bridge 进程监听在哪个地址。
  - 容器内推荐值：`0.0.0.0`
  - 原因：只有监听 `0.0.0.0`，宿主机映射出来的 `4281` 端口才能从容器外访问。
- `CCLIENT_BRIDGE_PORT`
  - 作用：控制容器内 bridge 实际监听端口。
  - 默认值：`4281`
  - 典型场景：通常不改；如果你确实改了，前端公开配置也要同步调整。

#### 前端公开运行时配置

- `CCLIENT_PUBLIC_BRIDGE_ORIGIN`
  - 作用：直接告诉浏览器 HTTP API 应该请求哪个完整地址。
  - 例子：`http://107.148.164.139:4285`
  - 优先级：最高。只要设置了它，前端就不会再自行拼 host/port。
- `CCLIENT_PUBLIC_BRIDGE_WS_ORIGIN`
  - 作用：直接告诉浏览器终端 WebSocket 应该连哪个完整地址。
  - 例子：`ws://107.148.164.139:4285`
  - 优先级：最高。通常和 `CCLIENT_PUBLIC_BRIDGE_ORIGIN` 成对出现。
- `CCLIENT_PUBLIC_BRIDGE_HOST`
  - 作用：当你不想传完整 origin 时，用它指定 bridge 的主机名或 IP。
  - 例子：`107.148.164.139`
  - 配套关系：通常与 `CCLIENT_PUBLIC_BRIDGE_PORT` 搭配使用；如果同时给了完整 origin，则这个值会被忽略。
- `CCLIENT_PUBLIC_BRIDGE_PORT`
  - 作用：当你不传完整 origin 时，用它指定浏览器应访问的 bridge 端口。
  - 例子：`4285`
  - 配套关系：通常与 `CCLIENT_PUBLIC_BRIDGE_HOST` 搭配使用；如果同时给了完整 origin，则这个值会被忽略。
- `CCLIENT_PUBLIC_DEFAULT_PROJECT_PATH`
  - 作用：给前端设置“默认项目路径”，也就是设置页里初始展示的项目路径，以及首次扫描工作空间时默认提交给 bridge 的 `projectRoot`。
  - 容器内推荐值：`/workspace/company`
  - 典型场景：远程 Linux 容器部署时，避免前端默认展示本地 Windows 路径。

#### 辅助挂载配置

- `CODEX_HOME_HOST`
  - 作用：给 `docker-compose.yml` / `podman compose` 指定宿主机哪一个目录要挂到容器内的 `/root/.codex`。
  - 默认行为：如果不设，compose 会用仓库内的 `./runtime-data/codex-home`。
  - 典型场景：你希望直接复用宿主机已经登录好的 Codex 配置时，把它设成宿主机自己的 `~/.codex`。

### Docker

#### Linux / macOS / Git Bash

```bash
docker run --rm -it \
  -p 4273:4273 \
  -p 4281:4281 \
  -e CCLIENT_BRIDGE_HOST=0.0.0.0 \
  -e CCLIENT_PUBLIC_DEFAULT_PROJECT_PATH=/workspace/company \
  -v "$HOME/.codex:/root/.codex" \
  c-client:local
```

#### Linux root 用户

```bash
docker run --rm -it \
  -p 4273:4273 \
  -p 4281:4281 \
  -e CCLIENT_BRIDGE_HOST=0.0.0.0 \
  -e CCLIENT_PUBLIC_DEFAULT_PROJECT_PATH=/workspace/company \
  -v /root/.codex:/root/.codex \
  c-client:local
```

#### Windows PowerShell

```powershell
docker run --rm -it `
  -p 4273:4273 `
  -p 4281:4281 `
  -e CCLIENT_BRIDGE_HOST=0.0.0.0 `
  -e CCLIENT_PUBLIC_DEFAULT_PROJECT_PATH=/workspace/company `
  -v "${env:USERPROFILE}\\.codex:/root/.codex" `
  c-client:local
```

#### Windows CMD

```bat
docker run --rm -it ^
  -p 4273:4273 ^
  -p 4281:4281 ^
  -e CCLIENT_BRIDGE_HOST=0.0.0.0 ^
  -e CCLIENT_PUBLIC_DEFAULT_PROJECT_PATH=/workspace/company ^
  -v "%USERPROFILE%\\.codex:/root/.codex" ^
  c-client:local
```

### Podman

#### Linux / macOS / Git Bash

```bash
podman run --rm -it \
  -p 4273:4273 \
  -p 4281:4281 \
  -e CCLIENT_BRIDGE_HOST=0.0.0.0 \
  -e CCLIENT_PUBLIC_DEFAULT_PROJECT_PATH=/workspace/company \
  -v "$HOME/.codex:/root/.codex" \
  c-client:local
```

#### Windows PowerShell

```powershell
podman run --rm -it `
  -p 4273:4273 `
  -p 4281:4281 `
  -e CCLIENT_BRIDGE_HOST=0.0.0.0 `
  -e CCLIENT_PUBLIC_DEFAULT_PROJECT_PATH=/workspace/company `
  -v "${env:USERPROFILE}\\.codex:/root/.codex" `
  c-client:local
```

启动后：

- UI: `http://127.0.0.1:4273`
- bridge: `http://127.0.0.1:4281`

如果使用自定义宿主机端口，例如：

```bash
docker run --rm -it \
  -p 4275:4273 \
  -p 4285:4281 \
  -e CCLIENT_BRIDGE_HOST=0.0.0.0 \
  -e CCLIENT_PUBLIC_BRIDGE_ORIGIN=http://107.148.164.139:4285 \
  -e CCLIENT_PUBLIC_BRIDGE_WS_ORIGIN=ws://107.148.164.139:4285 \
  -e CCLIENT_PUBLIC_DEFAULT_PROJECT_PATH=/workspace/company \
  -v "$HOME/.codex:/root/.codex" \
  c-client:local
```

这样 `http://107.148.164.139:4275` 打开的页面会直接连到 `107.148.164.139:4285`，不再依赖构建阶段写死端口。

## 5. 使用 compose

当前仓库自带的 `docker-compose.yml` 已把 Codex 配置目录默认挂载到仓库内：

- `./runtime-data/codex-home -> /root/.codex`

同时默认提供：

- `CCLIENT_PUBLIC_DEFAULT_PROJECT_PATH=/workspace/company`

如果你想改为复用宿主机现有的 Codex 登录态，可以在启动前显式指定：

### Linux / macOS / Git Bash

```bash
export CODEX_HOME_HOST="$HOME/.codex"
docker compose up --build
```

### Linux root 用户

```bash
export CODEX_HOME_HOST=/root/.codex
docker compose up --build
```

### Windows PowerShell

```powershell
$env:CODEX_HOME_HOST = "$env:USERPROFILE\\.codex"
docker compose up --build
```

如果你的 UI 暴露端口和 bridge 暴露端口不是同一套默认值，也可以在启动前一起指定：

### Linux / macOS / Git Bash

```bash
export CCLIENT_PUBLIC_BRIDGE_ORIGIN="http://107.148.164.139:4285"
export CCLIENT_PUBLIC_BRIDGE_WS_ORIGIN="ws://107.148.164.139:4285"
docker compose up --build
```

如果你接受默认的仓库内挂载目录，不额外指定 `CODEX_HOME_HOST`，则直接执行：

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
- `./runtime-data/codex-home -> /root/.codex`（默认）

说明：

- 员工项目空间、成果和队列建议放在容器外挂载目录中
- 这样容器重建后数据仍然保留
- 如果设置了 `CODEX_HOME_HOST`，则第三项会改为你指定的宿主机 Codex 目录

## 7. 当前限制

- 当前 UI 默认项目路径已支持通过构建参数预设，默认值为 `/workspace/company`
- `打开目录 / 打开文件` 这类动作在容器内只会尝试打开容器内部路径，不会直接调宿主机资源管理器
- 这更适合作为本地开发 / 演示部署，不是完整生产托管方案

## 8. 常见排查

### 8.1 远程服务器页面里却显示本地 Windows 路径

常见现象：

- 你访问的是 `http://服务器IP:4273`
- 但设置页 `CODEX HOME` 却显示成类似 `C:/Users/.../.codex`

这通常不表示容器真的读到了你本地磁盘，而是表示：

- 当前页面实际连到的 bridge 不是服务器容器里的 bridge
- 而是浏览器所在机器上的另一个本地 bridge

优先检查：

1. 你是否用了包含最新 runtime-config 逻辑的镜像重新构建并启动容器
2. 远程页面打开后，浏览器请求的 `/runtime-config.js` 是否返回了正确的 bridge 地址
3. 你是否显式传了：
   - `CCLIENT_PUBLIC_BRIDGE_ORIGIN`
   - `CCLIENT_PUBLIC_BRIDGE_WS_ORIGIN`
4. 如果没显式传，当前 UI 和 bridge 是否确实暴露在同一台服务器的同一域名下

推荐做法：

- 默认同机部署：只保留 `-p 4273:4273 -p 4281:4281`，不额外传 bridge origin，让前端自动跟随当前页面域名
- 非默认端口或反向代理部署：显式传 `CCLIENT_PUBLIC_BRIDGE_ORIGIN` 和 `CCLIENT_PUBLIC_BRIDGE_WS_ORIGIN`

## 9. 后续建议

如果后续要正式支持容器部署，建议继续补：

1. 容器内默认项目路径预设
2. 宿主机文件打开代理
3. API Key 与 Codex 登录态文档化
4. 多容器 worker 模式
