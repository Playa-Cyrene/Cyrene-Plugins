# 保险箱（cyrene-vault）

把密码、API Key、授权码这类东西锁在本机。

## 怎么保密的

内容用 Windows DPAPI 加密，密钥跟当前 Windows 账户绑定。

哪怕整个文件被拷到别的电脑、别的账户下，也解不开——只有你这台机器、你这个账户能读。

存储位置：

```
%APPDATA%\Cyrene\plugin-data\cyrene-vault\vault.json
```

## 界面

插件卡片点「打开」，或者在对话里说「打开保险箱」。

窗口里可以直接新增、看一眼、删除。密码框里的内容不会经过对话，只在这扇窗里进到加密文件。

## 工具

| 工具 | 用途 |
| --- | --- |
| `cyrene-vault_list` | 列出存了哪些名字和长度，不返回值 |
| `cyrene-vault_save` | 存一条新的 |
| `cyrene-vault_get` | 取出明文，只在明确要求核对时用 |
| `cyrene-vault_delete` | 删除一条 |
| `cyrene-vault_open` | 打开管理界面 |

## 用法提醒

`cyrene-vault_save` 和 `cyrene-vault_get` 的明文会进入对话上下文。密码类凭据建议直接在界面里输入、用「看一眼」核对，不要走对话。

日常要让脚本用凭据时，读 `vault.json` 拿密文，在本机账户下解密即可，不必把明文交给 AI。

## 数据安全

删除凭据会真的从加密文件里移除。建议定期备份 `vault.json`——但备份文件只有在同一账户下才能解开。
