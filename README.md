# Model Harbor · 模型港

Model Harbor 是面向个人和可信局域网的多供应商模型网关。它提供统一的 OpenAI / Anthropic 兼容接口，并把官方 Codex、Claude Code、Grok CLI 和图像/视频服务接入同一个管理页面。

需要 Node.js 22+；运行时不依赖第三方 npm 包。

## 你可以用它做什么

| 能力 | 说明 |
| --- | --- |
| 统一网关 | 暴露 /v1/models、/v1/chat/completions、/v1/responses 和 /v1/messages，按供应商前缀区分同名模型。 |
| ` 供应商 | 转发 OpenAI 兼容上游，支持 Chat、Responses、Anthropic Messages，以及客户端工具调用。 |
| 官方 CLI 桥接 | 通过 SSH 或 SSH + Docker 调用已登录的 Codex app-server、Claude Code、Grok CLI；工具仍由客户端执行。 |
| 账号组 | 将多个 Codex 账号合并为一个模型前缀，按额度和优先级自动切换。 |
| OpenCode Go | 使用官方浏览器设备授权创建供应商，并显示官方用量。 |
| 媒体生成 | 管理网页生图、Grok 视频，以及 Codex/Grok 媒体 Skill 下载包。 |
| 管理页面 | 供应商、模型、用量、账号组、任务历史、访问凭据和界面语言均可管理。 |

## 快速开始

### 本机运行

~~~sh
git clone https://github.com/ash-629/model-harbor.git
cd model-harbor
npm start
~~~

打开 http://127.0.0.1:8317/，在「供应商」页添加上游。默认只监听回环地址；未设置管理密码时，本机管理页无需登录。

需要启用管理登录时，在启动进程的环境中设置 `GATEWAY_ADMIN_PASSWORD`，初始用户名为 admin：

~~~sh
node --env-file=.env src/server.js
~~~

Node 不会自动读取 .env。密码至少 8 个字符，登录设置可在「设置」页修改。

### Docker

~~~sh
cp ` .env
# 编辑 .env，至少设置管理密码和访问根地址
mkdir -p data
sudo chown 1000:1000 data
docker compose up -d --build
~~~

局域网部署时，同时调整端口绑定和 `GATEWAY_PUBLIC_URL`。非回环监听必须配置公开根地址和管理密码；公网使用时还应自行配置 HTTPS 和访问控制。

## 客户端接入

| 协议 | Base URL | 认证 |
| --- | --- | --- |
| OpenAI 兼容 | ` | ` |
| Anthropic Messages | ` | `，并发送 ` |

两种协议共享同一组模型。模型 ID 形如 ```；管理页「接入指南」会按当前部署地址生成示例。

## 供应商类型

### OpenAI 兼容上游

在管理页填写 Base URL、上游密钥和模型，或使用模型发现。网关可在 Chat、Responses 和 Anthropic Messages 之间做必要转换；客户端 custom、namespace 和 function 工具由客户端执行。

### Codex 官方 CLI

目标主机或容器需要安装并登录官方 Codex CLI。模型港通过 `codex app-server` 获取模型、注入历史并转发当前回合，不读取或导出 `auth.json`，也不直接请求 Codex 私有 Responses 接口。支持 SSH、SSH + Docker、客户端工具、多轮工具结果和实时文本 SSE。

多个 Codex 供应商可以组成账号组：组模型对外使用一个前缀，成员按顺序尝试；只有在尚未输出内容且判定为额度类错误时才切换，冷却状态会持久化。

Codex 桥接要求客户端发送完整历史和 `store=false`。它不提供 `previous_response_id`、服务端响应存储、WebSocket 或 compact；长历史仍受模型上下文窗口限制。

### Claude Code 官方 CLI

目标环境需要已登录 Claude Code、`python3` 和 `timeout`。网关启动 `claude-tool-runner.py`，支持文本/图片输入、客户端工具和多轮往返；Claude 模型别名默认是 `sonnet`、`opus`、`haiku`。订阅凭据只在目标环境中使用。

### Grok 官方 CLI

目标环境需要已登录 Grok CLI、`python3` 和 `timeout`。网关使用固定 runner 和结构化输出桥接客户端工具；当前聊天桥接不是逐 token 透传。聊天图片会先由一次仅开启 `Read` 工具的 CLI 调用转写为文本（绕开 `--prompt-json` 单参数约 128 KB 的限制），再参与结构化输出；代价是每张图多一次 CLI 往返（约 8-12 秒），模型看到的是转写文本而非原始像素。Grok 视频和订阅生图在「生成视频」「生图」菜单中单独配置。

### OpenCode Go

在「添加供应商」中选择「OpenCode Go · 浏览器授权」。授权后网关会创建或更新 `ocgo` 供应商，按模型自动选择 Chat 或 Responses 端点，并显示官方滚动用量。凭据在服务端加密保存，失效时需要重新授权。

## 图像、视频和 Skill

「生图」支持 OpenAI 兼容 Images API、MiniMax、Codex 和 Grok；支持后台任务、历史、下载和最多三张参考图。「生成视频」支持 Grok 订阅视频、6/10/15 秒和最多三张参考图。具体能力以供应商配置和页面校验为准。

页面还可下载三个局域网 Skill：Codex 生图、Grok 生图、Grok 生视频。解压后导入客户端，首次运行包内的 `scripts/media_client.py --configure`，填写网关地址和 `。Skill 只需要 Python 3.9+ 标准库，不包含 SSH 密钥或订阅凭据。

## 高级能力

- Codex 工具较多或 schema 较大时可启用 DeferLoading，把非核心工具延迟到 namespace；通过 `MH_DEFER_TOOLS` 等环境变量控制。
- OpenCode Go 可在转发前压缩历史 data: 图片；` 供应商可选启用工具描述和旧工具结果裁剪。
- app-server 会话失效或工具目录变化时，网关可以重建临时线程并注入可读历史，继续处理工具结果。
- DeepSeek 思考模式的工具回合会补齐客户端缺失的 reasoning_content；不可恢复的原始推理不会被伪造。
- Grok/OpenCode 的上游协议差异会在网关内部做定向转换，并保留客户端可用的工具调用契约。

这些优化可能改变请求体积或首包延迟；需要完整原始历史时，应关闭对应优化或重新读取源文件。

## 常用配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | 8317 | HTTP 端口 |
| `HOST` | 本机 127.0.0.1；Docker 0.0.0.0 | 监听地址 |
| `GATEWAY_DATA_DIR` | ./data | 配置、密钥、任务和媒体目录 |
| `GATEWAY_PUBLIC_URL` | 空 | Host/Origin 校验和接入指南地址 |
| `GATEWAY_ADMIN_PASSWORD` | 空 | 初始管理密码 |
| `GATEWAY_API_BODY_LIMIT_MB` | 128 | 聊天 JSON 上限，范围 1–256 |
| `MH_AGENT_MAX_SECONDS` | 7200 | Codex app-server 进程时限 |
| `MH_TOOL_WAIT_SECONDS` | 1800 | 客户端工具结果等待时限 |
| `MH_IMAGE_OPTIMIZATION` | opencode | 图片压缩：off / opencode / all |
| `MH_DEFER_TOOLS` | auto | Codex 工具延迟加载：off / auto / always |

完整示例见 `。工具下载代理使用 `MH_TOOL_PROXY`（兼容 `TOOL_DOWNLOAD_PROXY`）。

## 数据和安全

运行时数据默认保存在 `：`config.json`、`master.key`、媒体任务和下载文件都属于部署私有数据。上游密钥和网关密钥使用 AES-256-GCM 加密，管理密码保存为 scrypt 哈希；能同时读取配置和主密钥的人仍可解密，因此必须保护整个数据目录。

远程 CLI 只在目标环境中使用其登录态。模型港不会把 Codex、Claude 或 Grok 登录文件写入仓库，也不会把客户端工具交给远程环境执行。不要把生产配置、SSH 文件、登录缓存或个人部署记录提交到 Git。

## 设计文档

系统架构见 [docs/architecture.md](docs/architecture.md)。

## 开发和验证

~~~sh
npm test
npm run check
~~~

Node 回归测试覆盖管理鉴权、供应商 CRUD、协议转换、SSE、工具往返、长历史、官方 CLI 桥接、账号组、OpenCode Go、媒体任务、图片压缩和界面行为；当前共 181 项。Python 执行器可按需单独运行：

~~~sh
`python3` test/grok-tool-runner.test.py
`python3` test/grok-image-runner.test.py
`python3` test/grok-video-runner.test.py
~~~

测试使用模拟上游和临时数据，不调用真实模型或真实账号。字体许可证见 `public/FONT-LICENSE.txt`。
