# 发布脚本（维护者工具）：从 plugins/ 源码构建 ZIP，发布为 GitHub Release 附件
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/publish-plugins.ps1                        发布全部有新版本的插件
#   powershell -ExecutionPolicy Bypass -File scripts/publish-plugins.ps1 -PluginId weather-tool 只发布指定插件
#   powershell -ExecutionPolicy Bypass -File scripts/publish-plugins.ps1 -PluginId minecraft-bot -Prerelease 发布指定插件为预发布
# 前置：已安装 gh CLI 并完成 gh auth login；合并插件 PR 后运行本脚本
# 规则：每个版本一个独立 Release（tag = <插件id>-<版本>），附件下载量由 GitHub 自动计数；
#       tag 已存在时跳过，绝不覆盖旧 Release（保留历史版本下载计数）。
#       本地 zips/ 目录只是发布中转，不提交进仓库（已加入 .gitignore）。

param(
    # 只发布指定插件 id；缺省遍历全部插件目录
    [string]$PluginId,
    # 创建 GitHub 预发布（适合 Beta / RC）
    [switch]$Prerelease
)

$ErrorActionPreference = "Stop"
$Repo = "Playa-Cyrene/Cyrene-Plugins"
$root = Split-Path -Parent $PSScriptRoot
$pluginsDir = Join-Path $root "plugins"
$zipsDir = Join-Path $root "zips"
$registryPath = Join-Path $root "registry.json"
New-Item -ItemType Directory -Force $zipsDir | Out-Null

$registry = Get-Content $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
$changed = $false

Get-ChildItem $pluginsDir -Directory | Where-Object { -not $PluginId -or $_.Name -eq $PluginId } | ForEach-Object {
    $manifestPath = Join-Path $_.FullName "manifest.json"
    if (-not (Test-Path $manifestPath)) {
        Write-Warning "跳过 $($_.Name)：缺少 manifest.json"
        return
    }
    $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.id -ne $_.Name) {
        throw "$($_.Name)：目录名与 manifest id（$($manifest.id)）不一致，中止发布"
    }

    $entry = $registry.plugins | Where-Object { $_.id -eq $manifest.id }
    if (-not $entry) {
        throw "registry.json 中没有登记 $($manifest.id)，请先补登记再发布"
    }

    $tag = "$($manifest.id)-$($manifest.version)"
    # 幂等保护：该版本已发布过 Release 就跳过
    # （gh 对不存在的 release 会向 stderr 写错误，EAP=Stop 时 stderr 重定向
    #   会被提升为终止错误，这里临时放宽再恢复）
    $ErrorActionPreference = "Continue"
    gh release view $tag --repo $Repo 2>$null | Out-Null
    $releaseExists = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = "Stop"
    # Release 已存在且索引齐全才真正跳过；索引缺失（如发布后回写中途失败）走补写路径
    if ($releaseExists -and $entry.zip -and $entry.sha256) {
        Write-Host "跳过 ${tag}：Release 已存在"
        return
    }

    $zipName = "${tag}.zip"
    $zipPath = Join-Path $zipsDir $zipName
    if ($releaseExists) {
        # 补写索引：Release 已存在但 registry 缺下载地址，从 Release 拉回附件，不重复发布
        Write-Host "补写索引 ${tag}：Release 已存在但 registry 缺少下载地址"
        if (-not (Test-Path $zipPath)) {
            gh release download $tag --repo $Repo --pattern $zipName --dir $zipsDir
            if ($LASTEXITCODE -ne 0) {
                throw "gh release download ${tag} 失败"
            }
        }
    } else {
        # ZIP 内保留一层插件目录，与 GitHub「Download ZIP」形态一致，宿主导入逻辑支持
        Compress-Archive -Path $_.FullName -DestinationPath $zipPath -Force
    }
    $sha256 = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host ("发布 {0}  ({1:N1} kB)  sha256={2}" -f $zipName, ((Get-Item $zipPath).Length / 1KB), $sha256)

    if (-not $releaseExists) {
        $releaseArgs = @("release", "create", $tag, $zipPath, "--title", $tag, "--notes", $manifest.description, "--repo", $Repo)
        if ($Prerelease) {
            $releaseArgs += "--prerelease"
        }
        & gh @releaseArgs
        if ($LASTEXITCODE -ne 0) {
            throw "gh release create ${tag} 失败"
        }
    }

    # 回写索引：下载地址指向 Release 附件，附 SHA-256 供客户端校验完整性
    # （zip/sha256 字段提交者按规范留空，不存在的属性必须用 Add-Member 赋值）
    $entry | Add-Member -NotePropertyName version -NotePropertyValue $manifest.version -Force
    $entry | Add-Member -NotePropertyName zip -NotePropertyValue "https://github.com/$Repo/releases/download/$tag/$zipName" -Force
    $entry | Add-Member -NotePropertyName sha256 -NotePropertyValue $sha256 -Force
    # 市场客户端要求 downloads 必须是数字，缺失的条目会被整条丢弃；每日聚合 Action 之后会更新为真实下载量
    if ($null -eq $entry.downloads) {
        $entry | Add-Member -NotePropertyName downloads -NotePropertyValue 0 -Force
    }
    $changed = $true
}

if ($changed) {
    $registry.updatedAt = Get-Date -Format "yyyy-MM-dd"
    # 统一写 UTF-8 无 BOM + 2 空格缩进（ConvertTo-Json 默认格式会造成整文件 diff 噪音）
    # 统一写 UTF-8 无 BOM（嵌套引号的 node -e 管道在 PowerShell 下会被截断导致写空文件，禁止使用）
    [System.IO.File]::WriteAllText($registryPath, ($registry | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
    Write-Host "registry.json 已更新，请提交推送"
}
