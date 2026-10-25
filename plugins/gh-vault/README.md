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
- `gh-vault_reveal`：取出令牌明文，必须传 `confirm: "REVEAL"`；明文会进入对话上下文，无法撤回
- `gh-vault_clear`：删除已保存的令牌，必须传 `confirm: "DELETE"`

## 存储与网络行为

- 令牌保存在本机插件存储中，不写入任何其他文件
- 支持系统加密时（Windows 下为 Electron safeStorage / DPAPI）以密文保存；当前环境不支持系统加密时会退回本机明文存储，工具状态里会明确提示
- 只有 `gh-vault_api` 与「测试连接」会联网，且目标固定为 `api.github.com`
- 不上传遥测，不访问其他域名

## 已知限制

- 令牌权限范围由 GitHub 侧决定，插件不做细粒度限制
- 调用 `gh-vault_reveal` 后明文会留在本次对话记录中，请只在确实需要核对的场景使用
- 插件不自带令牌，也不提供 OAuth 登录流程

开发者：昔涟
