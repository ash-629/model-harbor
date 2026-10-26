# Model Harbor 系统设计

## 1. 设计目标

Model Harbor 是一个单进程 Node.js 网关，面向个人或可信局域网部署。它把不同供应商的认证、协议和远程执行方式收敛到统一的管理页面与 API，同时保留上游差异，避免把供应商凭据或客户端工具执行权限扩散到远程环境。

设计目标有四个：

1. **统一接入**：客户端可以使用 OpenAI Chat/Responses 或 Anthropic Messages 接口访问不同供应商。
2. **隔离凭据**：上游 API Key、网关 Key 和远程 CLI 登录态分开保存，管理页面只返回脱敏配置。
3. **可组合的远程桥接**：Codex、Claude Code、Grok 使用目标环境中的官方 CLI，网关负责协议转换和回合编排。
4. **可恢复的任务处理**：媒体生成使用持久化任务记录；流式请求、工具回合和额度切换都有明确的失败边界。

非目标是把所有上游能力伪装成完全相同的协议，也不在 NAS 或网关容器中执行客户端提供的 shell、patch、MCP 或多代理工具。

## 2. 总体架构

~~~mermaid
flowchart LR
    C[客户端<br/>OpenAI / Anthropic / Skill] -->|HTTP| S[Node.js HTTP Server<br/>src/server.js]
    S --> A[管理鉴权<br/>AdminAuth + session/CSRF]
    S --> P[协议层<br/>Chat / Responses / Messages / SSE]
    S --> D[(Store<br/>data/config.json + master.key)]
    P --> U[上游路由<br/>src/upstream.js]
    U --> O[OpenAI 兼容供应商]
    U --> N[Codex app-server<br/>SSH / SSH+Docker]
    U --> CL[Claude Code<br/>SSH / SSH+Docker]
    U --> G[Grok CLI<br/>SSH / SSH+Docker]
    S --> M[媒体 API 与任务队列]
    M --> I[Images provider / Codex / Grok]
    M --> V[Grok video runner]
    S --> T[工具下载与 Skill ZIP]
~~~

核心模块的职责如下：

| 模块 | 主要职责 |
| --- | --- |
| src/server.js | HTTP 路由、请求限制、Host/Origin 校验、管理 API、媒体 API 和静态页面。 |
| src/store.js | 配置持久化、凭据加密、供应商/账号组 CRUD、原子写盘和公开数据脱敏。 |
| src/protocol.js | Chat、Responses、SSE 事件和工具消息的结构转换。 |
| src/upstream.js | 供应商路由、协议选择、账号组故障切换和上游错误归类。 |
| src/nas-agent.js | Codex app-server 会话、模型发现、历史注入、客户端工具和流式增量。 |
| src/claude-code.js / src/grok-code.js | Claude/Grok 官方 CLI 的远程进程桥接。 |
| src/images.js / src/videos.js | 媒体任务创建、队列、状态、文件保存和恢复查询。 |
| src/media-api.js | 面向 Skill 的 Bearer 媒体接口，不开放管理会话。 |
| public/ | 同源管理页面、供应商编辑、账号组、任务历史和多语言 UI。 |

## 3. 请求生命周期

### 3.1 普通模型请求

~~~mermaid
sequenceDiagram
    autonumber
    participant C as 客户端
    participant H as HTTP Server
    participant S as Store
    participant R as Upstream Router
    participant P as 上游供应商

    C->>H: POST /v1/chat/completions 或 /v1/responses
    H->>H: 校验 Host、Origin、JSON 大小和 Bearer Key
    H->>S: 读取供应商公开配置与加密凭据
    H->>R: route request, provider, signal
    R->>R: 选择协议适配器和模型 ID
    R->>P: 转发请求或启动远程 CLI
    P-->>R: 非流结果 / SSE / 工具调用
    R-->>H: 统一响应事件
    H-->>C: JSON 或 response SSE
~~~

请求取消会触发同一请求的 AbortController，由路由层继续传给上游 HTTP、SSH 进程和媒体任务。服务端不把完整提示词写入普通日志；日志只保存有限的诊断字段和用量信息。

### 3.2 Anthropic Messages

/v1/messages 在进入上游前转换为内部消息表示，文本、图片、工具调用、工具结果和 thinking 参数由 src/anthropic.js 与协议层处理。响应再转换回 Anthropic SSE 或非流 JSON。系统消息被映射为内部 developer 上下文；不支持的 Anthropic 服务端工具和 token-counting 能力会按兼容边界返回错误。

## 4. 远程 CLI 与客户端工具

远程 CLI 只负责推理，不执行客户端工具。工具回合由客户端闭环完成：

~~~mermaid
sequenceDiagram
    autonumber
    participant C as 客户端
    participant H as Model Harbor
    participant B as CLI Bridge
    participant X as Codex / Claude / Grok

    C->>H: 当前消息 + tools
    H->>B: 建立远程会话并注册动态工具
    B->>X: 启动官方 CLI / app-server
    X-->>B: tool call name, arguments
    B-->>H: 结构化工具调用
    H-->>C: function/custom/namespace tool call
    C->>C: 本地执行工具
    C->>H: tool result，可含图片
    H->>B: 续接同一回合或重建临时线程
    B->>X: 注入工具结果
    X-->>B: 最终文本 / 更多调用
    B-->>H: delta、完成或错误
    H-->>C: SSE 增量与 response.completed
~~~

### Codex 特殊流程

Codex 使用官方 codex app-server：

1. thread/start 创建 ephemeral thread，并注册动态客户端工具。
2. 使用分块 thread/inject_items 注入可读历史。
3. turn/start 只发送当前用户消息。
4. 监听 item/agentMessage/delta 转成 Responses 文本增量。
5. 工具结果返回时，如果原会话已失效或工具目录变化，重建 thread 并重新注入历史。

历史裁剪只发生在明确的兼容/容量策略中：旧 reasoning 项可省略，较早图片可替换为占位文本，旧的超长工具输出保留头尾。客户端需要发送完整历史，并使用 store=false；网关不提供持久 Responses 查询、previous_response_id、WebSocket 或 compact。

### Claude 与 Grok 特殊边界

Claude 使用 claude-tool-runner.py 的 JSON Schema / stream-json 输出。Grok 使用固定 runner 和 --verbatim，在临时 HOME 中运行，关闭远程 shell、MCP、hooks、web search、subagent 和 plan 权限。两者的订阅登录文件留在目标环境，不复制进网关配置。
## 5. 账号组与额度切换

账号组把多个 nas-codex 供应商映射为一个公开前缀，例如 codex/gpt-6.1-sol。成员顺序就是优先级，成员模型集合合并去重。

~~~mermaid
flowchart TD
    A[收到账号组请求] --> B{成员是否在冷却?}
    B -->|是| C[跳过成员]
    B -->|否| D[尝试当前成员]
    C --> E{还有成员?}
    D --> F{已向客户端输出?}
    F -->|是| G[直接返回错误或完成结果]
    F -->|否| H{错误是否为额度类?}
    H -->|否| G
    H -->|是| I[记录冷却 until / reason]
    I --> E
    E -->|是| D
    E -->|否| J[返回组耗尽错误]
~~~

切换条件是“尚未向客户端输出内容”且错误被归类为额度或速率限制。网络、登录、上下文超限和结构化输出错误不会盲目重试。流式账号组会延迟打开下游 SSE，直到上游回合确认可用；单供应商流式请求仍保持实时输出。冷却状态保存在 groupState，重启后继续生效；管理页可同步用量或手动清除冷却。

## 6. 媒体任务架构

网页生图和视频生成与聊天路由分离。供应商配置保存在 Store，任务由 ImageJobs / VideoJobs 创建并写入 data/，执行器完成后保存原文件和公开元数据。

~~~mermaid
stateDiagram-v2
    [*] --> queued: POST /api/.../jobs
    queued --> running: 队列取得任务
    running --> completed: runner 成功并保存文件
    running --> failed: runner / 校验失败
    queued --> cancelled: 任务取消或进程退出
    running --> cancelled: 请求终止
    completed --> [*]
    failed --> [*]
    cancelled --> [*]
~~~

面向 Skill 的 /v1/media/{image|video} 使用网关 Bearer Key，只返回启用供应商的必要信息。任务查询和文件下载复用任务访问校验；使用 --job-id 可以恢复查询和下载，不会自动重复生成。参考图最多三张，具体尺寸、时长和格式由对应 provider 校验。

## 7. 数据与安全模型

~~~mermaid
flowchart LR
    K[master.key<br/>0600] --> E[AES-256-GCM]
    E --> C[config.json<br/>上游 Key / Gateway Key 密文]
    P[管理密码] --> H[scrypt 哈希]
    B[浏览器管理页] -->|session cookie + CSRF| A[管理 API]
    S[Skill / API 客户端] -->|Bearer Gateway Key| M[媒体 API]
    R[远程 CLI] -->|SSH 登录态留在目标环境| X[Codex / Claude / Grok]
~~~

安全边界：

- 管理 API 需要短期 session cookie；写请求还需要 CSRF token。
- /v1 和 /v1/media 使用独立的 Bearer 网关 Key；管理密码不会作为模型 API Key 使用。
- Store 使用原子临时文件加 rename 写盘，避免半写配置；公开配置永远不返回上游密文。
- GATEWAY_PUBLIC_URL、Host 和 Origin 校验用于限制局域网管理页面的访问入口。
- 远程 CLI 的 SSH 私钥、订阅登录文件和个人 SSH guard 不属于仓库发布内容。
- 生产部署应保护整个 data/ 目录；同时拥有 config.json 与 master.key 的进程可以解密上游凭据。

## 8. 部署拓扑

~~~mermaid
flowchart TB
    subgraph LAN[可信局域网]
        U[浏览器 / API 客户端]
        H[model-harbor<br/>Node.js :8317]
        D[(data volume)]
        U --> H
        H <--> D
    end
    H -->|SSH| N1[codex-linux<br/>Codex app-server]
    H -->|SSH| N2[claude-linux<br/>Claude runner]
    H -->|SSH| N3[grok / runner<br/>Grok CLI]
    H --> O[API Key 上游]
~~~

Docker 镜像只承载网关代码和必要运行时；配置、主密钥、媒体文件和下载缓存通过 data/ 持久化。远程容器需要自行安装并登录对应官方 CLI。生产重建网关会清空进程内的会话和工具缓存，但不会覆盖持久化数据或远程登录态。

## 9. 扩展约束

新增供应商或协议适配器时，保持以下约束：

1. 在 Store 中定义最小可持久化字段，并明确哪些字段需要加密。
2. 在 upstream.js 或独立 bridge 中完成协议转换，不把供应商特例散落到 HTTP 路由。
3. 对流式、工具调用、取消和上游错误分别提供测试；额度切换必须证明“未输出前才可重试”。
4. 不把客户端工具执行迁移到远程 CLI；远程 runner 只返回结构化调用或最终结果。
5. 新增媒体 provider 时复用任务状态、文件访问和参考图校验，不创建第二套持久化格式。
6. 更新 README 时保留使用者视角；实现细节和流程变化放在本目录，并在变更后运行 npm test 与 npm run check。

## 10. 验证清单

~~~sh
npm test
npm run check
~~~

Node 测试覆盖管理鉴权、供应商 CRUD、协议转换、SSE、工具往返、长历史、CLI bridge、账号组、媒体任务和图片优化。Python runner 测试可按需运行：

~~~sh
python3 test/grok-tool-runner.test.py
python3 test/grok-image-runner.test.py
python3 test/grok-video-runner.test.py
~~~

测试使用模拟上游和临时数据，不调用真实模型或真实账号。
