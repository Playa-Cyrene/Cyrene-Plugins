# mail-send

用 Cyrene 已配置的 SMTP 账号静默发信。全程没有确认框，不需要打开邮箱网页。

## 工具

| 工具 | 用途 |
| --- | --- |
| `mail-send_send` | 发送邮件，支持多个附件 |
| `mail-send_status` | 自检：脚本在不在、SMTP 配置全不全（不返回密码） |

### mail-send_send 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `to` | 是 | 收件人地址 |
| `subject` | 否 | 主题，默认 `Cyrene Mail` |
| `body` | 否 | 纯文本正文 |
| `bodyFile` | 否 | UTF-8 文件路径，正文从文件读，优先于 `body` |
| `attach` | 否 | 附件绝对路径数组 |
| `timeoutSeconds` | 否 | 超时，默认 180 秒 |

返回里出现 `SENT_OK` 表示 SMTP 服务器已接收。

## 依赖

- 平台：Windows（依赖 PowerShell 5.1，其他系统无法发信）
- 发信脚本：插件目录内的 `send_mail.ps1`（手写 SMTP over implicit TLS，能连 465 端口）。插件目录里没有时，回退到 `%LOCALAPPDATA%\CyreneMaintenance\send_mail.ps1`
- 配置：`%APPDATA%\Cyrene\app-settings.json` 中的 `emailSmtpHost` / `emailSmtpPort` / `emailSmtpUser` / `emailSmtpPass` / `emailFromName`

两者缺一，`mail-send_status` 会直接指出来。

## 网络与数据

- 只连接你在 app-settings.json 里配置的 SMTP 服务器，不访问其他域名，不采集遥测
- 邮件正文与附件会写进系统临时目录，发送结束后在 `finally` 里删除
- 密码只从 app-settings.json 读取，`mail-send_status` 只报告「已设置」，不回显内容
- 发信脚本运行时会关闭证书校验（为了兼容部分自签证书的 SMTP 服务）；如果你只连 163、QQ 邮箱这类公共服务器，可以自行把 `send_mail.ps1` 第 109 行的 `return $true` 改成标准校验

## 实现要点

- 正文写入临时文件时带 UTF-8 BOM。PowerShell 5.1 的 `-Encoding UTF8` 读无 BOM 文件会按 ANSI 解，中文会烂。
- 参数用单引号包裹并转义内部单引号，避免路径里的空格和中文出问题。
- 子进程带超时和 `ctx.signal` 中断；临时目录在 `finally` 里清理。
- 附件以 base64 内联进 MIME，单封信总大小受 SMTP 服务器限制（163 一般 ≤ 50 MB）。

## 安装

把目录复制到 `%APPDATA%\Cyrene\plugins\mail-send\`，或在插件面板导入 zip。插件默认停用，需要在插件卡片上点「启用」。
