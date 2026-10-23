---
name: model-harbor-grok-image
description: 通过局域网模型港调用 NAS 上已登录的 Grok 远程生图，支持文字提示和最多三张本机参考图，自动取回原始文件。用于用户要求通过模型港或远程 Grok 生成图片。
---

# Grok 远程生图

使用本 skill 的 `scripts/media_client.py`，脚本路径相对于本 SKILL.md 所在目录解析，不依赖当前项目或原作者电脑。需要 Python 3.9+，只用标准库；Windows 用 `python`（或 `py -3`），macOS/Linux 用 `python3`。模型港默认地址 `http://192.168.2.37:8317`，可用 `MODEL_HARBOR_URL` 或 `--base-url` 改为部署者提供的地址。

## 首次安装与配置

将 ZIP 内整个 `model-harbor-grok-image` 文件夹放到用户的 `~/.codex/skills/`（Windows：`%USERPROFILE%\.codex\skills\`），或用客户端的 skill 导入功能。重新打开客户端以发现 skill。其他支持 SKILL.md 的客户端使用其自己的 skill 目录。

运行 `python <skill目录>/scripts/media_client.py --configure`，在终端输入模型港地址和网页「接入指南」中的网关 API Key。不要让用户把密钥发进聊天；交互输入不回显。三个 skill 共用 `~/.model-harbor/client.json`，一次配置即可。也可通过 `MODEL_HARBOR_URL`、`MODEL_HARBOR_API_KEY` 环境变量使用已有配置。不需要 NAS SSH 密钥、Docker、Codex/Grok 本机安装或订阅登录；远端服务必须已启用且调用电脑可访问模型港。

下载包不带密钥。网关 API Key 同时授权模型港现有 API，不能当作仅生图的独立权限；仅交给已授权使用网关的电脑。

## 调用

```text
python <skill目录>/scripts/media_client.py --list
python <skill目录>/scripts/media_client.py --prompt "用户的画面描述" --aspect 1:1 --output "本机输出路径/result.png"
python <skill目录>/scripts/media_client.py --prompt-file "prompt.txt" --ref "本机参考图.png" --aspect 1:1 --output "本机输出路径/reference-result.png"
```

`--ref` 可重复最多三次，PNG/JPEG/WebP，每张不超过 5 MB，按传入顺序上传。`--prompt` 和 UTF-8 `--prompt-file` 二选一。提示词和内容风格遵从当前用户要求，不套用其他项目模板。先用 `--list` 查看可用服务商；默认只在匹配 grok 类型且唯一时自动选择，多个时用 `--provider ID` 指定。图片支持 1:1、3:2、2:3、16:9、9:16；默认 1:1。最终尺寸和文件格式由远端工具决定，查看输出 JSON 中的 ext，必要时在本机更正文件后缀。

## 结果与恢复

脚本先打印任务 ID，再轮询状态，完成后保存原始字节并打印本机绝对路径、字节数和 SHA-256。使用用户指定输出目录；没有指定则在当前项目选择清楚的唯一文件名。默认拒绝覆盖，只有用户允许才用 `--overwrite`。完成后向用户展示本机图片。远端仅负责生成，后续剪辑、缩放、转码在本机按任务需要进行。

默认等待 1800 秒，可用 `--timeout` 调整。等待超时或下载失败时保留打印的任务 ID，用下式继续查询和取回，不重新提交生成：

```text
python <skill目录>/scripts/media_client.py --job-id TASK_UUID --output "本机输出路径/result.png"
```

提交请求发生网络异常且未返回任务 ID 时，先到模型港生成记录确认是否已受理，避免重复消耗额度。远程失败应报告原错误，不用其他生成器替代却声称来自此服务。401 重新配置 Key；无服务商请部署者检查启用状态。
