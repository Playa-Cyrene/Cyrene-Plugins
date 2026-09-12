import { cp, mkdir, readdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RUNTIME_LIMITS = {
  files: 2_000,
  bytes: 200 * 1024 * 1024,
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(scriptDir, "..");
const sourceRuntimeDir = path.join(rootDir, "bot-runtime");
const packagedRuntimeDir = path.join(rootDir, "plugins", "minecraft-bot", "runtime", "bot-runtime");

// Mineflayer's tested Java versions, plus the version data referenced by them.
const retainedPcDataDirs = new Set([
  "1.7", "1.8", "1.9", "1.9.4", "1.10", "1.10.2", "1.11", "1.11.2",
  "1.12", "1.12.2", "1.13", "1.13.2", "1.14", "1.14.4", "1.15", "1.15.2",
  "1.16", "1.16.1", "1.16.2", "1.16.4", "1.16.5", "1.17", "1.17.1",
  "1.18", "1.18.2", "1.19", "1.19.2", "1.19.3", "1.19.4", "1.20", "1.20.1",
  "1.20.2", "1.20.3", "1.20.4", "1.20.5", "1.20.6", "1.21.1", "1.21.3",
  "1.21.4", "1.21.5", "1.21.6", "1.21.8", "1.21.9", "1.21.11", "26.1", "common",
]);

const removableDirectoryNames = new Set([
  "test", "tests", "doc", "docs", "example", "examples", "coverage", "benchmark", "benchmarks",
]);

const unsupportedOfflineAuthPackages = [
  "prismarine-auth", "prismarine-realms", "@azure", "@xboxreplay", "rxjs", "yggdrasil", "node-rsa",
];

function assertReplacement(source, before, after, file) {
  if (source.includes(before)) return source.replace(before, after);
  if (after && source.includes(after)) return source;
  throw new Error(`无法为离线发布版修补依赖：${file} 的预期代码已变化`);
}

function removeReplacement(source, before) {
  if (source.includes(before)) return source.replace(before, "");
  // 已裁剪的发布运行时可安全重复执行本脚本。
  return source;
}

async function deferUnsupportedAuthentication(nodeModulesDir) {
  const createClientPath = path.join(nodeModulesDir, "minecraft-protocol", "src", "createClient.js");
  let createClient = await readFile(createClientPath, "utf8");
  createClient = removeReplacement(createClient, "const auth = require('./client/mojangAuth')\n");
  createClient = removeReplacement(createClient, "const microsoftAuth = require('./client/microsoftAuth')\n");
  createClient = assertReplacement(createClient, "        auth(client, options)", "        require('./client/mojangAuth')(client, options)", createClientPath);
  createClient = assertReplacement(
    createClient,
    "          microsoftAuth.realmAuthenticate(client, options).then(() => microsoftAuth.authenticate(client, options)).catch((err) => client.emit('error', err)).then(onReady)",
    "          { const microsoftAuth = require('./client/microsoftAuth'); microsoftAuth.realmAuthenticate(client, options).then(() => microsoftAuth.authenticate(client, options)).catch((err) => client.emit('error', err)).then(onReady) }",
    createClientPath,
  );
  createClient = assertReplacement(
    createClient,
    "          microsoftAuth.authenticate(client, options).catch((err) => client.emit('error', err))",
    "          require('./client/microsoftAuth').authenticate(client, options).catch((err) => client.emit('error', err))",
    createClientPath,
  );
  await writeFile(createClientPath, createClient);

  const encryptPath = path.join(nodeModulesDir, "minecraft-protocol", "src", "client", "encrypt.js");
  let encrypt = await readFile(encryptPath, "utf8");
  encrypt = removeReplacement(encrypt, "const yggdrasil = require('yggdrasil')\n");
  encrypt = removeReplacement(
    encrypt,
    "  const yggdrasilServer = yggdrasil.server({ agent: options.agent, host: options.sessionServer || 'https://sessionserver.mojang.com' })\n",
  );
  encrypt = assertReplacement(
    encrypt,
    "        yggdrasilServer.join(options.accessToken, client.session.selectedProfile.id,",
    "        require('yggdrasil').server({ agent: options.agent, host: options.sessionServer || 'https://sessionserver.mojang.com' }).join(options.accessToken, client.session.selectedProfile.id,",
    encryptPath,
  );
  await writeFile(encryptPath, encrypt);

  const indexPath = path.join(nodeModulesDir, "minecraft-protocol", "src", "index.js");
  let index = await readFile(indexPath, "utf8");
  index = removeReplacement(index, "const createServer = require('./createServer')\n");
  index = assertReplacement(index, "  createServer,", "  createServer: (...args) => require('./createServer')(...args),", indexPath);
  await writeFile(indexPath, index);
}

async function pruneDevelopmentFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (removableDirectoryNames.has(entry.name.toLowerCase())) {
        await rm(entryPath, { recursive: true, force: true });
      } else {
        await pruneDevelopmentFiles(entryPath);
      }
    } else if (entry.name.endsWith(".map") || entry.name.endsWith(".ts")) {
      await rm(entryPath, { force: true });
    }
  }
}

async function pruneMinecraftData(nodeModulesDir) {
  const pcDataDir = path.join(nodeModulesDir, "minecraft-data", "minecraft-data", "data", "pc");
  for (const entry of await readdir(pcDataDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !retainedPcDataDirs.has(entry.name)) {
      await rm(path.join(pcDataDir, entry.name), { recursive: true, force: true });
    }
  }

  const dataRoot = path.join(nodeModulesDir, "minecraft-data", "minecraft-data");
  const bedrockDataDir = path.join(dataRoot, "data", "bedrock");
  for (const entry of await readdir(bedrockDataDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "common") {
      await rm(path.join(bedrockDataDir, entry.name), { recursive: true, force: true });
    }
  }
}

export async function inspectRuntime(runtimeDirOrUrl) {
  const runtimeDir = runtimeDirOrUrl instanceof URL ? fileURLToPath(runtimeDirOrUrl) : runtimeDirOrUrl;
  let files = 0;
  let bytes = 0;

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(entryPath)).size;
      }
    }
  }

  await walk(runtimeDir);
  return { files, bytes };
}

export async function pruneRuntime(runtimeDir) {
  const packagedNodeModules = path.join(runtimeDir, "node_modules");
  await pruneMinecraftData(packagedNodeModules);
  await deferUnsupportedAuthentication(packagedNodeModules);
  for (const packageName of unsupportedOfflineAuthPackages) {
    await rm(path.join(packagedNodeModules, packageName), { recursive: true, force: true });
  }
  await pruneDevelopmentFiles(packagedNodeModules);

  const metrics = await inspectRuntime(runtimeDir);
  if (metrics.files > RUNTIME_LIMITS.files || metrics.bytes > RUNTIME_LIMITS.bytes) {
    throw new Error(`发布运行时超出安装器上限：${metrics.files} 个文件，${metrics.bytes} 字节`);
  }
  return metrics;
}

export async function prepareReleaseRuntime() {
  const sourceNodeModules = path.join(sourceRuntimeDir, "node_modules");
  if (!(await stat(sourceNodeModules)).isDirectory()) {
    throw new Error("bot-runtime 缺少 node_modules；请先在 bot-runtime 目录执行 npm install");
  }

  await rm(packagedRuntimeDir, { recursive: true, force: true });
  await cp(sourceRuntimeDir, packagedRuntimeDir, { recursive: true });
  const packagedScriptDir = path.join(packagedRuntimeDir, "scripts");
  await mkdir(packagedScriptDir, { recursive: true });
  await cp(scriptPath, path.join(packagedScriptDir, "prepare-release-runtime.mjs"));
  return pruneRuntime(packagedRuntimeDir);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const metrics = process.argv.includes("--in-place")
    ? await pruneRuntime(rootDir)
    : await prepareReleaseRuntime();
  console.log(`发布运行时已就绪：${metrics.files} 个文件，${(metrics.bytes / 1024 / 1024).toFixed(2)} MiB`);
}
