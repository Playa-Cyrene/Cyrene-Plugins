// 下载量聚合脚本：统计所有 Release 附件的下载次数，按插件 id 累加写回 registry.json
// 由 GitHub Actions 每日自动运行（.github/workflows/aggregate-downloads.yml），也可本地手动执行。
// 口径：插件总下载量 = 该插件所有历史版本 Release 附件下载次数之和（发新版不清零）。
import { readFile, writeFile } from "node:fs/promises";

const REPO = "Playa-Cyrene/Cyrene-Plugins";
const REGISTRY_PATH = new URL("../registry.json", import.meta.url);

// 分页拉取全部 Release；优先用 GITHUB_TOKEN 提高速率限额（本地未登录则匿名）
async function fetchReleases() {
  const headers = { "User-Agent": "cyrene-plugins-aggregator" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const releases = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`,
      { headers },
    );
    if (!response.ok) throw new Error(`拉取 Release 列表失败: HTTP ${response.status}`);
    const batch = await response.json();
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

const registry = JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
const releases = await fetchReleases();

// tag 命名规则：<插件id>-<版本>；按 registry 中的 id 做前缀匹配，避免版本号含连字符时误切分
let changed = false;
for (const plugin of registry.plugins) {
  const total = releases
    .filter((release) => release.tag_name.startsWith(`${plugin.id}-`))
    .reduce(
      (sum, release) => sum + release.assets.reduce((s, asset) => s + asset.download_count, 0),
      0,
    );
  if (plugin.downloads !== total) {
    plugin.downloads = total;
    changed = true;
  }
}

if (!changed) {
  console.log("下载量无变化，跳过写入");
} else {
  registry.updatedAt = new Date().toISOString().slice(0, 10);
  await writeFile(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  console.log("registry.json 下载量已更新");
}
