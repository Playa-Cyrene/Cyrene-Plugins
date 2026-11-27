# 百度网盘 API 保险箱（bdpan-vault）

把百度网盘 API Key 存在本机，让 Agent 代发接口请求，Key 不出现在对话里。

## 工具

| 工具 | 作用 |
| --- | --- |
| `bdpan-vault_status` | 查看是否已保存、掩码、保存时间、加密方式，不返回明文 |
| `bdpan-vault_api` | 用保存的 Key 代发请求，Key 在插件内部拼接 |
| `bdpan-vault_reveal` | 取出明文，需要 `confirm: "REVEAL"` |
| `bdpan-vault_clear` | 删除保存的 Key，需要 `confirm: "DELETE"` |

## 存储与加密

- 存在 Cyrene 的插件存储里，键名 `bdpanApiKey`
- Windows 上优先用 Electron `safeStorage` 加密，底层是 DPAPI，密钥绑定当前 Windows 账户，此时记录里 `enc: true`
- **当前环境拿不到 `safeStorage` 时会退回明文存储**，记录里 `enc: false`，`bdpan-vault_status` 会明确显示「本机明文存储（当前环境不支持系统加密）」
- 不支持把加密记录拷到别的机器解开；换账户后需要重新填 Key

## 网络

只允许以下主机：

`pan.baidu.com`、`openapi.baidu.com`、`aippt.baidu.com`、`apaas.baidu.com`、`d.pcs.baidu.com`、`pcs.baidu.com`、`yun.baidu.com`

- `path` 必须是 `/` 开头的路径，完整网址会被拒绝
- 请求超时 20 秒（面板连通性测试 15 秒），响应体超过 400 KB 中断
- 返回给 Agent 的正文截断到 8000 字符
- 响应里如果出现 Key 原文，会被替换成 `[REDACTED]`

## 文件与子进程

- 不读写用户目录下的文件，不启动子进程
- 面板 `panel.html` 是本地静态页，不加载远程内容
- `bdpan-vault_reveal` 的返回值会进入对话上下文并留存，日常调用接口请用 `bdpan-vault_api`

## 平台

Windows 优先（DPAPI 可用时自动加密）。其他平台也能用，但 `safeStorage` 不可用时会明文存储。

## 使用

在插件市场安装「百度网盘 API 保险箱」，默认不启用，需要手动打开。打开后点插件面板填入 Key，面板里有连通性测试。
