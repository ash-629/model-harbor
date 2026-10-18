# Model Harbor · 模型港

个人和可信局域网使用的多供应商模型网关：统一 OpenAI / Anthropic 兼容地址、官方 Codex 与 Claude Code 远程编排、中英文像素风管理页面和网页生图。需要 Node.js 22+，无第三方 npm 运行依赖。

## 功能

- 管理 OpenAI 兼容供应商，自动发现或手动填写模型，使用供应商前缀区分同名模型。
- `/v1/models`、`/v1/chat/completions`、`/v1/responses`，原协议转发及 Chat → Responses 转换。
- `/v1/messages` 接收 Anthropic Messages 请求，并转换到现有 Responses 路由。
- 通过 SSH 或 SSH + Docker 接入官方 Codex app-server；支持客户端 function/custom/namespace 工具、完整结构化历史、实时文本 SSE、用量查询及确认后手动重置额度。
- 通过 SSH 或 SSH + Docker 接入官方 Claude Code；支持客户端工具、图片输入、工具图片结果和多轮往返。
- 网页生图：OpenAI 兼容 Images API、MiniMax API、本机或远程 Codex；参考图、后台队列、历史和原图下载。
- “设置”菜单可启用或关闭管理页面的用户名密码登录，立即生效并持久化。

## 本机启动

```sh
git clone https://github.com/ash-629/model-harbor.git
cd model-harbor
npm start
```

打开 http://127.0.0.1:8317/。默认仅监听回环地址，未配置管理密码时本机管理页面无需登录。需要登录时，在启动进程的环境变量中设置 `GATEWAY_ADMIN_PASSWORD`；初始用户名为 `admin`。可在“设置”中修改用户名和密码，密码留空保留当前值。新密码至少 8 个字符，保存后需使用新凭据重新登录。Node 启动不会自动加载 `.env`，可用 Node 22 的 `node --env-file=.env src/server.js`。

在“供应商”页填写自己的上游配置并刷新模型。在右上角“接入指南”中查看 OpenAI 与 Anthropic 两种接入方式，并复制网关地址和网关 API Key。调用 ID 形如 `provider/model-id`；客户端 API Key 与上游密钥分别管理。

## 接入地址

- OpenAI 兼容：Base URL 使用 `http://<host>:8317/v1`，支持 `/v1/models`、`/v1/chat/completions`、`/v1/responses`。认证使用 `Authorization: Bearer <gateway-key>`。
- Anthropic Messages：Base URL 使用 `http://<host>:8317`，请求 `/v1/messages`。认证使用 `x-api-key: <gateway-key>`，并按客户端要求发送 `anthropic-version: 2023-06-01`。

两种协议共用同一组模型和调用 ID，管理页的“接入指南”会按当前部署地址生成示例。

## Docker

```sh
cp .env.example .env
# 编辑 .env，设置自己的强管理密码和实际访问根地址。
mkdir -p data
# Linux 下为镜像的 UID/GID 1000 设置此专用目录的写权限。
sudo chown 1000:1000 data
docker compose up -d --build
```

示例只发布本机端口。局域网访问时，调整 Compose 端口绑定和 `GATEWAY_PUBLIC_URL`，使其与浏览器访问地址一致。非回环监听必须同时配置公开根地址和管理密码。个人管理页面不应直接映射至公网，需要公网访问时应自行配置 HTTPS 和访问控制。

| 环境变量 | 用途 |
| --- | --- |
| `PORT` | HTTP 端口，默认 8317 |
| `HOST` | Node 默认 127.0.0.1，Docker 内为 0.0.0.0 |
| `GATEWAY_DATA_DIR` | 数据目录，默认工程下 data/ |
| `GATEWAY_PUBLIC_URL` | 部署访问根地址，用于 Host/Origin 校验 |
| `GATEWAY_ADMIN_PASSWORD` | 管理密码，用户名 admin |
| `GATEWAY_API_BODY_LIMIT_MB` | 聊天 JSON 大小上限，默认 64 MiB，范围 1–256 |

关闭管理登录后，任何能访问该地址的人都可以管理模型港。此开关不会关闭 `/v1` 的 Bearer API Key 验证。

## Codex 官方 CLI 接入

Codex 聊天链路使用目标环境中的官方 `codex app-server`，通过 SSH 或 SSH + Docker 运行。模型港只负责编排和协议转换，不读取或导出 `auth.json`，也不直接请求 Codex 私有 Responses 接口。

前置条件：目标主机或容器已安装并登录官方 Codex；模型港容器可读取 SSH 私钥；SSH + Docker 模式还需要目标用户的免交互 Docker 权限。

配置字段包括执行方式、SSH 主机/用户/端口/私钥、Docker 容器名、Docker 命令路径、CLI 可执行文件路径和请求超时。大历史建议设置 600 秒超时。

实现要点：

- 模型发现使用官方 `model/list`，不读取 `models_cache.json`。
- 新建会话先启动 ephemeral `thread/start` 并注册动态客户端工具，再通过分块的 `thread/inject_items` 注入结构化历史；`turn/start` 只发送当前用户消息。
- function、custom、namespace、tool_search 等客户端工具会映射为原生动态工具调用，工具在客户端执行，结果回到同一推理回合。
- `item/agentMessage/delta` 会实时转换为 Responses SSE 文本增量；工具调用项仍在回合完成后汇总。
- `thread/inject_items` 是实验接口。旧 CLI 不支持时，只有不超过 1,048,576 字符的历史可使用短历史兼容路径；长历史会明确报错，不会静默截断或改走 token 直连。
- 长历史仍受模型上下文窗口限制；字符数不是 token 上限。
- 不支持 `previous_response_id`、服务端响应存储、`store=true`、WebSocket 和 compact，客户端应发送完整历史和 `store=false`。
- 远程 app-server 的 shell、patch、apps、plugins、MCP、图片生成和多代理工具默认关闭，远程进程只负责推理。

`examples/ssh-command-guard.py` 是可选的受限 SSH 强制命令示例。它默认使用 `codex-linux`、`/usr/local/bin/docker` 和固定 Codex 路径；使用前必须按自己的容器、用户目录、CLI 路径和时间限制修改。

## Claude Code 官方 CLI 接入

Claude 聊天链路使用官方 Claude Code 的 `--json-schema` / `stream-json` 能力。模型港通过 SSH 或 SSH + Docker 启动 `claude-tool-runner.py`，官方 CLI 负责认证和推理，客户端工具在调用方执行。

目标环境需安装并登录 Claude Code，并提供 `python3`、`timeout` 和可执行的 Claude CLI。执行器源码为 `src/claude-tool-runner.py`，默认目标路径为 `/workspace/model-harbor/claude-tool-runner.py`。

支持 function/custom/namespace、长工具名、客户端 tool search、图片输入、工具图片结果和多轮工具往返；Claude 模型别名默认为 `sonnet`、`opus`、`haiku`。该链路直接使用官方 CLI 登录，不通过模型港读取或转发订阅 token。

## 网页生图

生图入口位于管理页「生图」，支持 OpenAI 兼容或 MiniMax Images API、本机或远程 Codex。Codex 生图执行器是 `src/codex-image-runner.py`，与 Codex 聊天接入相互独立；远程生图仍需安装、登录 Codex 并部署该执行器。参考图最多 3 张，具体限制以页面和服务商能力为准。

## 协议边界

Codex 桥接要求完整历史和 `store=false`；不支持持久 Responses 查询、`previous_response_id`、服务端响应存储、WebSocket 或 compact。工具由客户端执行，远程 Codex 负责推理。custom grammar 作为指令传递，不提供原生语法强制校验。输出 token 字段转为生成提示，不保证严格截断。工具定义、预算或模型变化可能重建上下文。

原生 API 供应商按所选协议转发。Chat → Responses 转换支持的能力取决于上游，不等同所有原生 Responses 特性。原生文字搜索可在 Codex 支持时启用，图片搜索声明不会被冒充为实际图片检索能力。

Anthropic Messages 支持文本、图片、工具调用与结果、流式 SSE 和 `thinking` 参数；`thinking` 会转换为推理强度提示，历史 thinking 文本按普通助手上下文保留。Anthropic 服务端工具、`stop_sequences`、`top_k`、提示缓存控制和 token-counting 端点不在兼容范围内。消息数组中的 system 消息会转换为 developer 上下文。

## 数据与凭据

运行时自动生成 `data/config.json` 和 `data/master.key`。管理密码修改后保存为加盐 scrypt 哈希，优先于启动环境变量中的初始密码；用户名和密码配置重启后保留。上游密钥和网关密钥使用 AES-256-GCM 加密；能同时读取主密钥和配置的人仍可解密，因此必须保护整个数据目录。生图任务和输出也保存在 data/，备份请保存在私有位置。

仓库不包含生产数据、真实密钥、密码、SSH 文件、登录缓存、图片历史或个人部署记录。`.env.example` 只有占位配置。测试中的 `test-password`、`upstream-test-key` 等都是本地模拟值。

## 验证

```sh
npm test
npm run check
```

当前 Node 回归测试为 70 项，覆盖管理鉴权、供应商 CRUD、协议转换、流式 SSE、客户端工具往返、长历史注入、模型发现、Codex/Claude 工具桥接、图片队列和 i18n。测试使用模拟上游和临时数据，不调用真实模型、不消耗真实账号重置次数。

字体及其许可证见 [public/FONT-LICENSE.txt](public/FONT-LICENSE.txt)。
