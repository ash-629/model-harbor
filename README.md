# Model Harbor · 模型港

个人使用的多供应商模型网关，提供统一 OpenAI 兼容地址和中英文像素风管理页面。需要 Node.js 22+，无第三方 npm 运行依赖。

## 功能

- 管理 OpenAI 兼容供应商，自动发现或手动填写模型，使用供应商前缀区分同名模型。
- `/v1/models`、`/v1/chat/completions`、`/v1/responses`，原协议转发及 Chat → Responses 转换。
- `/v1/messages` 接收 Anthropic Messages 请求，并转换到现有 Responses 路由。
- 通过 SSH 或 SSH + Docker 接入已登录的 Codex app-server；支持客户端 function/custom 工具往返、用量查询及确认后手动重置额度。
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

## Codex 与图像执行器

SSH 目标需安装并登录 Codex，并提供 `python3` 和 `timeout`。Docker 模式需要容器名及免交互 Docker 权限；聊天模型发现兼容容器用户目录 `/home/dev/.codex/models_cache.json`，不同布局需调整对应路径。纯 SSH 模式从目标账号的 Codex 目录发现模型。

原生 Responses 直连使用 `src/codex-responses-runner.py`，需放到目标环境的 `/workspace/model-harbor/codex-responses-runner.py`；如果修改了固定路径，应同步调整 `src/nas-responses.js` 与受限 SSH 命令。

生图时，从管理页下载执行器，或使用 `src/codex-image-runner.py`，放到目标环境的专用目录。配置执行器绝对路径、SSH 主机、用户和私钥路径。预先核对并信任 SSH 主机密钥；Docker 中的私钥应由部署者自行只读挂载。不要提交私钥或 Codex 登录文件。

`examples/ssh-command-guard.py` 是可选的受限 SSH 强制命令示例，默认容器名 `codex-linux`、容器用户目录 `/home/dev`，并限制为图像执行器和 Responses 转发程序的固定路径。使用前必须与自己的部署配置对齐，它不是通用 SSH 权限配置工具。

## 协议边界

Codex 桥接要求完整历史和 `store=false`；不支持持久 Responses 查询、`previous_response_id`、WebSocket 或 compact。工具由客户端执行，远程 Codex 负责推理。custom grammar 作为指令传递，不提供原生语法强制校验。输出 token 预算转为模型提示，响应 metadata 披露该限制，不保证严格截断。工具定义或预算变化可能重建上下文。

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

测试使用模拟上游和临时数据，不调用真实模型、不消耗真实账号重置次数。Python 执行器与 Responses 转发测试需 Python 3。支持 Windows 和 Linux 开发，远程 SSH 执行环境需 POSIX 工具。

字体及其许可证见 [public/FONT-LICENSE.txt](public/FONT-LICENSE.txt)。
