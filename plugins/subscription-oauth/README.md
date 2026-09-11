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
- 按各服务的原生协议转发请求

## 安装与使用

1. 在 Cyrene 的插件页选择本插件 ZIP，安装后启用并打开。
2. 选择订阅服务并完成浏览器 OAuth 授权。
3. 点击「查看用量/模型」，再点击「一键写入全部模型档案」。
4. 返回聊天窗口，从模型选择器中选择新写入的订阅模型。

本地代理监听 `127.0.0.1:6231`。端口被占用时插件会明确报错。

## 权限、网络与数据

- 仅申请宿主的 `secrets` 权限，用于加密保存 OAuth 凭据；凭据不写入明文文件或日志。
- 登录、模型目录、用量查询和对话会连接各服务的官方域名：
  - OpenAI：`auth.openai.com`、`chatgpt.com`
  - Anthropic：`claude.ai`、`console.anthropic.com`、`api.anthropic.com`
  - xAI：`auth.x.ai`、`api.x.ai`、`cli-chat-proxy.grok.com`
- 对话内容只发送给所选服务；插件没有遥测或第三方回传。
- 账号标签仅在插件窗口中脱敏显示，主进程日志和状态工具不输出邮箱或 accountId。
- 模型档案通过宿主 API 写入；宿主窗口不可用时会写入 `userData/model-settings.json` 并提示重启。
- 诊断文件只保留排查所需信息，并移除 token、邮箱及账号、用户和组织标识。

## 注意事项

- 本插件复用各家 CLI 客户端的 OAuth 流程，服务方接口或策略变更后可能需要更新插件。
- 请仅使用本人合法订阅的账号，并遵守对应服务条款。
- 跨协议切换模型后建议新建对话，避免历史工具调用格式不兼容。

## 作者

[1971687396](https://github.com/1971687396)
