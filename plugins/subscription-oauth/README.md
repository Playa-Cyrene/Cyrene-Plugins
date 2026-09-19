<p align="center">
  <img src="./icon.png" width="96" alt="订阅 OAuth 插件图标" />
</p>

# 订阅 OAuth（ChatGPT / Claude / Grok）

用 ChatGPT、Claude 或 Grok 的订阅账号登录，在 Cyrene 中通过本地代理使用订阅模型，无需填写 API Key。

## 功能

- 支持 ChatGPT Plus / Pro、Claude Pro / Max、SuperGrok / X Premium+
- 支持多账号登录、切换和凭据更新
- 拉取可用模型、思考档位、上下文长度和订阅用量
- 一键写入 Cyrene 模型档案
- 支持 Cyrene 工具调用及工具结果续轮
- 使用 ChatGPT 或 Grok Build 订阅生图，并在聊天窗口直接显示轻量预览
- 按各服务的原生协议转发请求

## 安装与使用

1. 在 Cyrene 的插件页选择本插件 ZIP，安装后启用并打开。
2. 选择订阅服务并完成浏览器 OAuth 授权。
3. 点击「查看用量/模型」，再点击「一键写入全部模型档案」。
4. 返回聊天窗口，从模型选择器中选择新写入的订阅模型。

需要生图时，在 Cyrene「工具」页开启「Chat 模式工具增强」，并在 Chat 页签勾选「订阅生图（ChatGPT / Grok）」。之后直接在聊天中描述想生成的图片即可；当前使用 Grok 订阅模型或点名 Grok 时，工具会走 Grok Build 的原生 Imagine 能力。

本地代理首次使用时优先监听 `127.0.0.1:6231`，之后会复用模型档案中上次成功的端口。若该端口被其他软件占用，插件会自动寻找后续可用端口；迁移档案后还会等待宿主窗口就绪，并通过公开 API 同步刷新运行时模型缓存，无需重启、关闭代理软件或手工修改模型地址。

## 权限、网络与数据

- 仅申请宿主的 `secrets` 权限，用于加密保存 OAuth 凭据；凭据不写入明文文件或日志。
- 登录、模型目录、用量查询和对话会连接各服务的官方域名：
  - OpenAI：`auth.openai.com`、`chatgpt.com`
  - Anthropic：`claude.ai`、`console.anthropic.com`、`api.anthropic.com`
  - xAI：`auth.x.ai`、`api.x.ai`、`cli-chat-proxy.grok.com`
- 对话内容只发送给所选服务；插件没有遥测或第三方回传。
- 生图原图保存在插件私有数据目录；聊天记录只保存随机的本地预览 URL，不保存 Base64 或磁盘路径。
- 本地代理会向聊天窗口提供压缩后的 JPEG 预览，并提供原始格式图片的查看/下载链接；两者仅监听 `127.0.0.1`。
- 账号标签仅在插件窗口中脱敏显示，主进程日志和状态工具不输出邮箱或 accountId。
- 模型档案通过宿主 API 写入；宿主窗口不可用时会写入 `userData/model-settings.json` 并提示重启。
- 诊断文件只保留排查所需信息，并移除 token、邮箱及账号、用户和组织标识。

## 注意事项

- 本插件复用各家 CLI 客户端的 OAuth 流程，服务方接口或策略变更后可能需要更新插件。
- Grok 生图取决于账号的 Imagine 权限；免费或 X Basic 套餐不支持，订阅额度和地区限制以 Grok 实际返回为准。
- 请仅使用本人合法订阅的账号，并遵守对应服务条款。
- 跨协议切换模型后建议新建对话，避免历史工具调用格式不兼容。

## 作者

[1971687396](https://github.com/1971687396)
