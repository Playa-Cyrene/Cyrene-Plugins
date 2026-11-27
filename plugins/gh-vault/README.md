# GitHub 令牌保险箱（gh-vault）

在本机加密保存一枚 GitHub 令牌，让昔涟可以代你发 GitHub API 请求，而令牌不会出现在对话或工具返回值里。

## 使用方式

1. 在插件列表中启用「GitHub 令牌保险箱」，点击插件面板。
2. 粘贴一枚 GitHub Personal Access Token（`ghp_` 或 `github_pat_` 开头），可写一个备注，点保存。
3. 点「测试连接」确认令牌有效，面板会显示登录名与权限范围。
4. 之后直接对昔涟说「看看我的 GitHub 用户名」「给这个仓库开个 PR」即可。

## 提供的工具

- `gh-vault_status`：查看是否已保存令牌、掩码、保存时间与加密方式
- `gh-vault_api`：代发 GitHub REST API 请求，`path` 传 `/` 开头的 API 路径，支持 GET / POST / PATCH / PUT / DELETE
- `gh-vault_clear`：删除已保存的令牌，必须传 `confirm: "DELETE"`

插件没有给 Agent 提供「读取明文」的工具。需要核对令牌时，只能由用户自己在插件面板点「显示令牌」。

## 存储与网络行为

- 令牌保存在宿主提供的加密密钥存储（`ctx.deps.secrets`）里，不写进普通插件设置
- 旧版本写在普通 storage 里的数据会在首次读取时自动迁移过去
- 面板渲染进程关闭了 Node 集成，通过隔离 preload 只暴露一个受限的 IPC 入口
- 只有 `gh-vault_api` 与「测试连接」会联网，且目标固定为 `api.github.com`
- 不上传遥测，不访问其他域名

## 已知限制

- 令牌权限范围由 GitHub 侧决定，插件不做细粒度限制
- 宿主没有提供加密存储时，插件会明确报错，不会退回明文落盘
- 插件不自带令牌，也不提供 OAuth 登录流程

开发者：昔涟
