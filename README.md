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
- OpenCode Go 一键接入：官方浏览器设备授权，自动创建按模型自动路由 Chat/Responses 的 `ocgo` 供应商，并显示官方额度。
- Chat 上游支持客户端 custom/namespace 工具；Grok Responses 自动改写不受支持的工具声明，工具仍由客户端执行。
- 左侧「工具下载」可检测并下载 Windows 版 ChatGPT 桌面端安装包。
- OpenCode Go 请求可在转发前压缩历史 `data:` 图片，减少多图会话上传体积。

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

镜像内已安装 `openssh-client`、`python3`、`python3-pil` 和 `ca-certificates`。构建阶段可通过 `--build-arg DEBIAN_MIRROR=mirrors.tuna.tsinghua.edu.cn` 指定 apt 镜像；该参数只影响构建，不改变运行时网络。

示例只发布本机端口。局域网访问时，调整 Compose 端口绑定和 `GATEWAY_PUBLIC_URL`，使其与浏览器访问地址一致。非回环监听必须同时配置公开根地址和管理密码。个人管理页面不应直接映射至公网，需要公网访问时应自行配置 HTTPS 和访问控制。

| 环境变量 | 用途 |
| --- | --- |
| `PORT` | HTTP 端口，默认 8317 |
| `HOST` | Node 默认 127.0.0.1，Docker 内为 0.0.0.0 |
| `GATEWAY_DATA_DIR` | 数据目录，默认工程下 data/ |
| `GATEWAY_PUBLIC_URL` | 部署访问根地址，用于 Host/Origin 校验 |
| `GATEWAY_ADMIN_PASSWORD` | 管理密码，用户名 admin |
| `GATEWAY_API_BODY_LIMIT_MB` | 聊天 JSON 大小上限，默认 64 MiB，范围 1–256 |
| `MH_AGENT_MAX_SECONDS` | Codex app-server 进程总时限，默认 7200 |
| `MH_TOOL_WAIT_SECONDS` | 客户端工具结果等待时间，默认 1800 |
| `MH_TOOL_PROXY` / `TOOL_DOWNLOAD_PROXY` | 工具下载使用的代理，只在服务端读取 |
| `MH_IMAGE_OPTIMIZATION` | 请求图片压缩范围，`opencode`（默认）/`all`/`off` |
| `MH_IMAGE_MAX_DIMENSION` / `MH_IMAGE_QUALITY` | 压缩后最长边默认 1600、JPEG 质量默认 80 |

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

## OpenCode Go 接入

供应商页「＋ 添加供应商」→ 快速选择「OpenCode Go · 浏览器授权」→「浏览器授权并接入」。模型港使用 OpenCode 官方公开的设备授权流程（`client_id` 为 `model-harbor`），无需粘贴 API Key；取得的是访问令牌和刷新令牌，不会解析或恢复已有的长期 Key。

授权成功后读取所选工作区的 `/console/api/v2/config`，创建或更新一个 `ocgo` 供应商（`protocol=both`），按每个模型的官方端点自动路由到 Chat 或 Responses；Anthropic/Google-only 与无法识别的模型会被跳过并列出。已有同前缀供应商保留名称、开关、超时与 Token 优化设置。旧版本的 `ocgo-r` 会在再次授权时合并进 `ocgo`。

凭据在服务端加密保存，并随请求自动续期；刷新令牌通过并发锁串行使用，失效时提示重新授权。转发固定发送 `User-Agent: model-harbor/0.1.0` 和稳定的 `x-opencode-session`（优先采用客户端提供的会话头）。供应商卡片的额度来自官方 `/inference/go/v1/usage`，显示滚动（5 小时）/每周/每月剩余百分比，两个协议共享 30 秒缓存；缺失值显示未知而不是零。

管理端接口（均需管理员会话与 CSRF）：

- `POST /api/opencode-go/auth/start`：`{ "prefix": "ocgo" }`，返回临时授权 ID、设备码和官方链接。
- `POST /api/opencode-go/auth/:id/poll`：等待授权并自动配置供应商。
- `POST /api/opencode-go/auth/:id/cancel`：取消本次等待。
- `POST /api/opencode-go/authorize`：旧的手动 Key 接口，继续兼容。

授权等待在服务重启后失效，已保存的凭据会保留；关闭弹窗只取消等待，不会删除凭据。

## OpenCode / Grok 协议兼容

OpenCode Go 的上游是混合形态：Chat 端点不接受 `developer` 角色，Grok 的 Responses 端点拒绝 custom 工具、namespace、`web_search_preview` 系列以及部分搜索参数。模型港在转发前做定向改写，客户端契约保持不变：

- Chat 上游：custom/namespace/tool_search 工具包装成单字符串参数的 function，返回时还原为 `custom_tool_call`；SSE 使用 `custom_tool_call_input` 事件。grammar 只作为说明传递，不声称原生强制。历史中的 `developer` 消息规范化为 `system`，内容与顺序不变。
- Grok Responses：custom 工具同样以字符串函数包装并在响应中还原；namespace 展开为带稳定别名的普通函数；移除 `web_search_preview` 系列、`programmatic_tool_calling`、`external_web_access` 与 `search_context_size`，保留 `web_search`、`file_search`、`image_generation` 及已支持的搜索参数，并在 instructions 中说明被移除的工具不可用。工具参数根若为 `anyOf`/`oneOf`，会归一化为对象根 schema。
- 被移除的声明和参数记录在请求日志的 `droppedHosted` / `droppedArguments` 中，原始客户端请求不被修改。

加密历史回退：OpenCode Responses 明确返回 `Could not decode the compaction blob` 或 `Could not decrypt the provided encrypted_content` 时，模型港只重试一次，把 compaction 项替换为可读摘要（无摘要时明确告知加密历史不可读，不编造内容），并移除无可读文本的 opaque reasoning；合法的原生密文原样通过。回退次数记录在 `metrics.compactionFallback`。

## 网页生图

生图入口位于管理页「生图」，支持 OpenAI 兼容或 MiniMax Images API、本机或远程 Codex。Codex 生图执行器是 `src/codex-image-runner.py`，与 Codex 聊天接入相互独立；远程生图仍需安装、登录 Codex 并部署该执行器。参考图最多 3 张，具体限制以页面和服务商能力为准。

## 协议边界

Codex 桥接要求完整历史和 `store=false`；不支持持久 Responses 查询、`previous_response_id`、服务端响应存储、WebSocket 或 compact。工具由客户端执行，远程 Codex 负责推理。custom grammar 作为指令传递，不提供原生语法强制校验。输出 token 字段转为生成提示，不保证严格截断。工具定义、预算或模型变化可能重建上下文。

原生 API 供应商按所选协议转发。Chat → Responses 转换支持的能力取决于上游，不等同所有原生 Responses 特性。原生文字搜索可在 Codex 支持时启用，图片搜索声明不会被冒充为实际图片检索能力。

Anthropic Messages 支持文本、图片、工具调用与结果、流式 SSE 和 `thinking` 参数；`thinking` 会转换为推理强度提示，历史 thinking 与 redacted thinking 块按客户端契约省略，不改写成普通助手文本。Anthropic 服务端工具、`stop_sequences`、`top_k`、提示缓存控制和 token-counting 端点不在兼容范围内。消息数组中的 system 消息会转换为 developer 上下文。

## 工具下载

左侧「工具下载」提供 Windows 版 ChatGPT 桌面端。点击「检测更新」后，后台通过固定 Microsoft Store 产品 ID `9PLM9XGG6VKS` 查询最新 x64 MSIX，并使用配置好的 OpenWrt 代理下载。安装包保存到 `data/tools/chatgpt/`，下载有进度、完成后校验 SHA-1，只保留最新安装包，页面可直接下载缓存文件。

Microsoft Store 产品接口不提供安装包版本号，因此版本和包链接由公开的 Windows Update 包索引 `store.rg-adguard.net` 解析；安装包本身只从 `delivery.mp.microsoft.com` 下载。版本号、文件名和下载主机都做白名单校验，半成品文件会被清理。

代理地址通过私密 `deployment.env` 中的 `MH_TOOL_PROXY`（兼容 `TOOL_DOWNLOAD_PROXY`）注入，不会回显到页面或日志；镜像包含 `ca-certificates` 以验证代理后的 HTTPS 证书。

## 请求图片压缩

OpenCode Go 供应商的请求会在协议转换后、转发前压缩历史中的 `data:` 图片（Chat 与 Responses 两条路径都适用），降低多图长会话的上传字节和上游入口耗时；默认只对 OpenCode Go 生效。只处理请求体里的 data URL，不抓取远程图片，也不改写工具 schema 中的示例 URL。

| 环境变量 | 默认 | 用途 |
| --- | --- | --- |
| `MH_IMAGE_OPTIMIZATION` | `opencode` | `off` / `opencode` / `all` |
| `MH_IMAGE_MAX_DIMENSION` | `1600` | 最长边像素，保持比例，不放大 |
| `MH_IMAGE_QUALITY` | `80` | JPEG 质量，范围 30–95 |
| `MH_IMAGE_MIN_BYTES` | `350000` | 小于该值且尺寸未超限时跳过 |
| `MH_IMAGE_MAX_INPUT_BYTES` | `12582912` | 单张原图上限，超过则保留原图 |
| `MH_IMAGE_TIMEOUT_MS` | `15000` | 单张压缩超时 |
| `MH_IMAGE_CACHE_LIMIT` | `32` | 相同图片的内存缓存条数 |

压缩失败时保持原图并继续请求，不会阻断推理；带透明通道的图片保留 PNG，不透明图片输出 JPEG。日志的 `imageOptimization` 只记录图片数、原始/压缩后字节数和失败数，不记录图片内容。该步骤减少上传体积，不改变上游自身的排队与限流。

## 数据与凭据

运行时自动生成 `data/config.json` 和 `data/master.key`。管理密码修改后保存为加盐 scrypt 哈希，优先于启动环境变量中的初始密码；用户名和密码配置重启后保留。上游密钥和网关密钥使用 AES-256-GCM 加密；能同时读取主密钥和配置的人仍可解密，因此必须保护整个数据目录。生图任务和输出也保存在 data/，备份请保存在私有位置。

仓库不包含生产数据、真实密钥、密码、SSH 文件、登录缓存、图片历史或个人部署记录。`.env.example` 只有占位配置。测试中的 `test-password`、`upstream-test-key` 等都是本地模拟值。

## 验证

```sh
npm test
npm run check
```

当前 Node 回归测试为 140 项，覆盖管理鉴权、供应商 CRUD、协议转换、流式 SSE、客户端工具往返、长历史注入、模型发现、Codex/Claude 工具桥接、OpenCode Go 授权与额度、Grok 工具改写、加密历史回退、图片压缩、工具下载目录、图片队列和 i18n。测试使用模拟上游和临时数据，不调用真实模型、不消耗真实账号重置次数。

字体及其许可证见 [public/FONT-LICENSE.txt](public/FONT-LICENSE.txt)。

## Codex 工具延迟加载（DeferLoading）

`nas-codex`（官方 Codex app-server）路径会在工具较多或 schema 较大时，把非核心工具放入 `mh_group_N` namespace，并标记 `deferLoading: true`；核心工具保持 eager。默认 `auto`，工具少于 24 个且总 schema 小于 48KB 时不启用。

| 环境变量 | 默认 | 用途 |
| --- | --- | --- |
| `MH_DEFER_TOOLS` | `auto` | `off` / `auto` / `always` |
| `MH_DEFER_MIN_TOOLS` | `24` | auto 模式触发的最小工具数 |
| `MH_DEFER_MIN_BYTES` | `49152` | auto 模式触发的最小 schema 字节 |
| `MH_DEFER_GROUP_SIZE` | `12` | 每个 namespace 的工具数 |
| `MH_DEFER_MAX_EAGER` | `10` | 最多保留的 eager 工具数 |
| `MH_DEFER_MAX_EAGER_BYTES` | `65536` | eager schema 字节预算 |
| `MH_DEFER_MIN_EAGER` | `4` | 至少保留的 eager 工具数 |

需要临时关闭时，在 `deployment.env` 或容器环境设置 `MH_DEFER_TOOLS=off` 并重启容器。该功能只影响 `nas-codex` app-server 路径，不影响 API Key / OpenAI 兼容上游。

## 上下文优化与会话恢复

Codex 桥接会精简工具 Schema 元数据与描述，并保留 custom 工具的格式约束提示。历史注入会省略 reasoning 项，将较早图片替换为省略标记，对旧的超长工具输出保留头尾；近期用户轮次保留原始内容。上述裁剪有信息损失，需要旧内容时应重新读取源文件。

app-server 流空闲超时设为 180 秒；进程总时限默认 7200 秒，可通过 `MH_AGENT_MAX_SECONDS` 调整（受限 SSH 示例允许 600–14400 秒）。工具结果等待默认 1800 秒，可通过 `MH_TOOL_WAIT_SECONDS` 调整。工具结果返回时若原会话已失效，或工具目录发生变化，会重建 ephemeral thread 并注入结构化历史，响应 metadata 标记 `model_harbor_session=reconstructed_after_tool_result`。重建可能增加首包延迟，不等同原生持久会话续接。

## API Key 上游 Token 优化与用量观测

OpenAI 兼容 API Key 供应商支持独立的 `tokenOptimization` 配置，默认不做有损裁剪，与 Codex 工具延迟加载分开生效。管理页面可启用优化；也可通过供应商管理 API 设置以下字段：

| 字段 | 默认 | 用途 |
| --- | --- | --- |
| `enabled` | `false` | 启用函数工具描述及旧工具结果裁剪 |
| `toolDescriptionChars` | `2000` | 函数工具描述字符上限 |
| `oldToolResultChars` | `32768` | 旧的配对字符串工具结果字符上限 |
| `keepRecentUserTurns` | `3` | 保留最近用户轮次的完整工具结果 |
| `captureStreamUsage` | `false` | 请求兼容 Chat 上游返回流式 usage |

单次请求可发送 `X-Model-Harbor-Optimize: off` 跳过有损裁剪。JSON Schema、custom/native 工具、图片和近期历史保持不变。请求日志与管理端测试结果记录请求体积、工具体积、裁剪数量及上游实际 usage；缺失 usage 保持未知，不将字节数直接当作 Token。费用与缓存收益需按供应商计费及真实任务验证。

`test/helpers/api-token-benchmark.mjs` 是需要显式启用的真实模型基准，默认测试不会运行它。执行时必须设置 `MH_LIVE_BENCH=1` 和 `MH_BENCH_DATA`，会消耗上游额度；报告中的合成任务结果不代表生产平均节省率。

DeepSeek 供应商支持账户余额查询；管理会话过期后页面会尝试重新建立会话并重试一次。
