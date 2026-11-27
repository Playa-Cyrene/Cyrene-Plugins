# GitHub 入口 IP · Cyrene 插件

扫描 `github.com` 的可用入口 IP，按需写入 hosts。DSH 插件的 Cyrene 版本。

核心逻辑和 `dsh-github-dns` 相同：

- 多路 DoH（阿里 / 腾讯 / Cloudflare / Google）+ 系统 DNS + 兜底 IP 收集候选
- 对每个候选做真实 TLS 握手（SNI = `github.com`，校验证书和 2xx/3xx）
- 只在当前 IP 失效时切换，避免无意义改写
- hosts 只动自己的标记块，块外原样保留

## 安装

1. 把 `cyrene-github-dns` 文件夹压成 zip，或在开发期直接把文件夹复制到：
   `%APPDATA%\Cyrene\plugins\cyrene-github-dns\`
2. 在 Cyrene 聊天窗口的「插件」面板里启用
3. 点插件卡片的「打开」，进入设置窗口
4. 第一次使用点「安装计划任务」，在 UAC 弹窗里点「是」
5. 点「立即扫描」，等十几秒，再点「应用最优」

## 数据与备份

所有运行时数据在插件目录的 `data/`：

- `config.json`：设置和上次扫描结果
- `apply.json` / `apply-result.json`：插件与计划任务之间的协议文件
- `hosts.bak-*.txt`：每次改写前的 hosts 备份

计划任务名：`cyrene-github-dns-apply`。它只负责把 `apply.json` 里的请求落到 hosts，平时不运行。

## 与 DSH 版共存

`dsh-github-dns` 和本插件会写不同的标记块（`dsh-github-dns` / `cyrene-github-dns`），但同一个 `github.com` 在 hosts 里只能有一个生效。**建议只启用其中一个**，避免两个块互相覆盖。

## 工具

| 工具 | 作用 |
| --- | --- |
| `cyrene-github-dns_status` | 查看当前 IP、任务状态、上次扫描 |
| `cyrene-github-dns_scan` | 扫描候选并返回可用列表 |
| `cyrene-github-dns_apply` | 应用指定 IP（不传则用最优） |
| `cyrene-github-dns_clear` | 移除 hosts 标记块 |

## 安全边界

- 插件与 Cyrene 同权限运行，不改 hosts，只写 `data/` 下的请求文件
- 真正写 hosts 的动作由计划任务以最高权限执行，每次都有备份
- 只操作自己标记块内的行，不动 hosts 里的其他内容

## 开发

```bash
node --check index.cjs
node --check lib/scanner.cjs
node --check lib/hosts.cjs
```

冒烟测试：

```js
const plugin = require('./index.cjs')
plugin.register({
  registerTool(tool) { if (!tool.id.startsWith('cyrene-github-dns_')) throw new Error(tool.id) },
  registerIpc() {},
  onDispose() {},
  log() {},
}).then(() => console.log('ok'))
```
