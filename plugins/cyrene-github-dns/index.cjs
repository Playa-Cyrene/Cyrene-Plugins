'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const scanner = require('./lib/scanner.cjs')
const hostsLib = require('./lib/hosts.cjs')

const PLUGIN_ID = 'cyrene-github-dns'
const PLUGIN_DIR = __dirname
const DATA_DIR = path.join(PLUGIN_DIR, 'data')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const APPLY_FILE = path.join(DATA_DIR, 'apply.json')
const APPLY_RESULT = path.join(DATA_DIR, 'apply-result.json')
const SYSTEM_ROOT = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
const HOSTS_PATH = path.join(SYSTEM_ROOT, 'System32', 'drivers', 'etc', 'hosts')
const TASK_NAME = 'cyrene-github-dns-apply'
const MARK_START = '# >>> cyrene-github-dns >>>'
const MARK_END = '# <<< cyrene-github-dns <<<'
const DOMAINS = ['github.com', 'www.github.com']
const DEFAULT_CONFIG = { enabled: true, intervalMinutes: 10, currentIp: '', lastScan: null, lastApply: null }

let win = null
let scanTimer = null
let scanPromise = null
let hostsQueue = Promise.resolve()
let configQueue = Promise.resolve()
let ctxRef = null
let disposed = false

function log(...args) {
  try {
    if (ctxRef && typeof ctxRef.log === 'function') ctxRef.log(...args)
    else console.log('[cyrene-github-dns]', ...args)
  } catch {
    /* ignore */
  }
}

async function ensureDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true })
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await ensureDir()
  await fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

async function readConfig() {
  const saved = await readJson(CONFIG_FILE, null)
  return Object.assign({}, DEFAULT_CONFIG, saved || {})
}

function saveConfig(patch) {
  const run = async () => {
    const config = await readConfig()
    Object.assign(config, patch)
    await writeJson(CONFIG_FILE, config)
    return config
  }
  const next = configQueue.then(run, run)
  configQueue = next.catch(() => {})
  return next
}

function decodeHosts(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.subarray(3).toString('utf8')
  }
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    const swapped = Buffer.from(buffer.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  return buffer.toString('utf8')
}

async function readHosts() {
  try {
    return decodeHosts(await fsp.readFile(HOSTS_PATH))
  } catch {
    return ''
  }
}

async function readCurrentIp() {
  const block = hostsLib.readBlock(await readHosts(), MARK_START, MARK_END)
  return block ? block.ip : ''
}

function exec(file, args, timeout = 12000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message || error)))
      else resolve(String(stdout || ''))
    })
  })
}

async function taskState() {
  try {
    const text = await exec('schtasks', ['/query', '/tn', TASK_NAME, '/fo', 'LIST'], 8000)
    if (/Disabled|已禁用/i.test(text)) return 'Disabled'
    if (/Running|正在运行/i.test(text)) return 'Running'
    return 'Ready'
  } catch {
    return 'Missing'
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runHostsExclusive(fn) {
  const next = hostsQueue.then(fn, fn)
  hostsQueue = next.catch(() => {})
  return next
}

async function runTask() {
  const state = await taskState()
  if (state === 'Missing') throw new Error('计划任务还没安装，先点「安装计划任务」')
  if (state === 'Disabled') throw new Error('计划任务被禁用了，去任务计划程序里启用它')
  if (state === 'Running') await sleep(1200)
  await exec('schtasks', ['/run', '/tn', TASK_NAME], 15000)
}

async function waitResult(requestId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(400)
    const row = await readJson(APPLY_RESULT, null)
    if (row && row.requestId === requestId) return row
  }
  return null
}

function applyIp(ip) {
  if (disposed) throw new Error('插件已停用')
  if (!scanner.isIPv4(ip)) throw new Error('IP 格式不对')
  return runHostsExclusive(async () => {
    if (disposed) throw new Error('插件已停用')
    await ensureDir()
    const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    await writeJson(APPLY_FILE, { action: 'apply', ip, domains: DOMAINS, requestId, at: new Date().toISOString() })
    await runTask()
    const row = await waitResult(requestId)
    if (!row) {
      const state = await taskState()
      if (state === 'Disabled') throw new Error('计划任务被禁用了，去任务计划程序里启用它')
      if (state === 'Running') throw new Error('计划任务还在运行，稍等一下再试')
      throw new Error('计划任务没有回结果，检查任务是否被禁用')
    }
    if (!row.ok) throw new Error(row.error || '写入 hosts 失败')
    await saveConfig({ currentIp: ip, lastApply: { at: row.at, action: 'apply', ip, backup: row.backup } })
    return row
  })
}

function clearBlock() {
  if (disposed) throw new Error('插件已停用')
  return runHostsExclusive(async () => {
    if (disposed) throw new Error('插件已停用')
    await ensureDir()
    const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    await writeJson(APPLY_FILE, { action: 'clear', domains: DOMAINS, requestId, at: new Date().toISOString() })
    await runTask()
    const row = await waitResult(requestId)
    if (!row) throw new Error('计划任务没有回结果，检查任务是否被禁用')
    if (!row.ok) throw new Error(row.error || '恢复 hosts 失败')
    await saveConfig({ currentIp: '', lastApply: { at: row.at, action: 'clear', ip: '', backup: row.backup } })
    return row
  })
}

async function scanNow() {
  if (scanPromise) return scanPromise
  scanPromise = (async () => {
    const result = await scanner.scan({ host: scanner.TARGET_HOST, timeout: 4000, concurrency: 5 })
    const config = await readConfig()
    const currentIp = config.currentIp || await readCurrentIp()
    const lastScan = {
      at: result.scannedAt,
      elapsedMs: result.elapsedMs,
      candidates: result.candidates,
      okCount: result.rows.filter((row) => row.ok).length,
      best: result.best,
      errors: result.errors,
      rows: result.rows,
    }
    await saveConfig({ currentIp, lastScan })
    return lastScan
  })()
  try {
    return await scanPromise
  } finally {
    scanPromise = null
  }
}

async function stateNow() {
  const config = await readConfig()
  const currentIp = await readCurrentIp()
  const task = await taskState()
  if (currentIp !== config.currentIp) await saveConfig({ currentIp })
  return {
    ok: true,
    currentIp,
    installed: task !== 'Missing',
    taskState: task,
    enabled: config.enabled,
    intervalMinutes: config.intervalMinutes,
    lastScan: config.lastScan,
    lastApply: config.lastApply,
    hostsPath: HOSTS_PATH,
  }
}

async function applyBest() {
  const config = await readConfig()
  const best = config.lastScan && config.lastScan.best
  if (!best || !best.ip) throw new Error('还没有可用 IP，先扫描一次')
  return applyIp(best.ip)
}

async function installTask() {
  const script = path.join(PLUGIN_DIR, 'scripts', 'install-task.ps1')
  if (!fs.existsSync(script)) throw new Error('安装脚本缺失')
  const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const quoted = script.replace(/'/g, "''")
  const quotedPlugin = PLUGIN_DIR.replace(/'/g, "''")
  const taskUser = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\')
  const quotedUser = taskUser.replace(/'/g, "''")
  const command = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${quoted}" -PluginDir "${quotedPlugin}" -RequestId "${requestId}" -TaskUser "${quotedUser}"'`
  try {
    await exec('powershell.exe', ['-NoProfile', '-Command', command], 120000)
  } catch (error) {
    return { ok: false, message: '安装没有完成：' + (error && error.message ? error.message : error) }
  }
  const result = await readJson(path.join(DATA_DIR, 'install-result.json'), null)
  if (!result || result.requestId !== requestId) {
    return { ok: false, message: '安装脚本没有回结果，检查 UAC 是否被取消' }
  }
  if (!result.ok) return { ok: false, message: '安装失败：' + (result.error || '未知错误') }
  return { ok: true, message: '计划任务已安装' }
}

function scheduleScan(delayMs, first) {
  if (scanTimer) clearTimeout(scanTimer)
  scanTimer = setTimeout(async () => {
    if (disposed) return
    try {
      const config = await readConfig()
      if (config.enabled) {
        const scan = await scanNow()
        let currentOk = scan.rows.find((row) => row.ip === config.currentIp && row.ok)
        if (config.currentIp && !currentOk) {
          const currentRow = await scanner.probe(config.currentIp, { host: scanner.TARGET_HOST, timeout: 4000 })
          if (currentRow.ok) currentOk = currentRow
        }
        if (config.currentIp && !currentOk && scan.best && scan.best.ip !== config.currentIp) {
          if (disposed) return
          const latest = await readConfig()
          const latestHostsIp = await readCurrentIp()
          if (!latest.enabled || !latest.currentIp || latest.currentIp !== config.currentIp || latestHostsIp !== config.currentIp) {
            log('托管状态已变化，跳过自动切换')
            return
          }
          log('当前 IP 失效，自动切换到 ' + scan.best.ip)
          await applyIp(scan.best.ip)
        }
      }
    } catch (error) {
      log('自动扫描失败：' + (error && error.message ? error.message : error))
    }
    if (disposed) return
    const next = await readConfig()
    if (disposed) return
    scheduleScan(Math.max(2, Number(next.intervalMinutes) || 10) * 60000, false)
  }, first ? delayMs : delayMs)
}

async function register(ctx) {
  disposed = false
  ctxRef = ctx
  await ensureDir()

  ctx.registerTool({
    id: PLUGIN_ID + '_status',
    name: 'GitHub 入口 IP 状态',
    description: '查看当前 hosts 里的 GitHub 入口 IP、计划任务是否安装、上次扫描有几个可用 IP。用户问 github.com 打不开、GitHub 入口 IP 或 hosts 状态时使用。',
    enabled: true,
    risk: 'safe',
    effectKind: 'read',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      const state = await stateNow()
      const scan = state.lastScan || {}
      return JSON.stringify({
        当前hostsIP: state.currentIp || '未接管',
        计划任务: state.taskState,
        自动扫描: state.enabled,
        扫描间隔分钟: state.intervalMinutes,
        上次扫描: scan.at ? new Date(scan.at).toLocaleString('zh-CN') : '还没有扫描',
        候选数: scan.candidates || 0,
        可用数: scan.okCount || 0,
        最优IP: scan.best ? scan.best.ip + '（' + scan.best.ms + 'ms）' : '暂无',
      })
    },
  })

  ctx.registerTool({
    id: PLUGIN_ID + '_scan',
    name: '扫描 GitHub 入口 IP',
    description: '从多个 DoH 源和系统 DNS 收集 github.com 候选 IP，逐个做 TLS 握手验证，返回可用列表。用户说 GitHub 打不开、扫描入口 IP 时使用。',
    enabled: true,
    risk: 'network',
    effectKind: 'read',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      const scan = await scanNow()
      const lines = scan.rows.slice(0, 8).map((row) => {
        const status = row.ok ? '可用 ' + row.ms + 'ms' : (row.error || '失败')
        return row.ip + ' — ' + status
      })
      return '扫描完成：' + scan.candidates + ' 个候选，' + scan.okCount + ' 个可用。\n' + (lines.length ? lines.join('\n') : '没有候选')
    },
  })

  ctx.registerTool({
    id: PLUGIN_ID + '_apply',
    name: '应用 GitHub 入口 IP',
    description: '把指定 IP（不传则用上次扫描的最优 IP）写入 hosts 的标记块，切换 github.com 的入口。用户说应用、切换、写入 hosts 时使用。',
    enabled: true,
    risk: 'write',
    effectKind: 'write',
    inputSchema: {
      type: 'object',
      properties: { ip: { type: 'string', description: '要写入的 IPv4，不传就用上次扫描的最优 IP' } },
      required: [],
    },
    async execute(args) {
      const ip = args && args.ip ? String(args.ip) : ''
      const row = ip ? await applyIp(ip) : await applyBest()
      return '已写入 hosts：' + row.ip + '（备份：' + (row.backup || '无') + '）'
    },
  })

  ctx.registerTool({
    id: PLUGIN_ID + '_clear',
    name: '恢复 GitHub hosts',
    description: '移除 hosts 里由本插件写入的标记块，恢复系统 DNS 解析。用户说恢复 hosts、撤销 GitHub 入口时使用。',
    enabled: true,
    risk: 'write',
    effectKind: 'write',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      await clearBlock()
      return '已移除 hosts 里的标记块，GitHub 恢复走系统 DNS。'
    },
  })

  ctx.registerIpc('state', () => stateNow())
  ctx.registerIpc('scan', async () => ({ ok: true, scan: await scanNow() }))
  ctx.registerIpc('apply', async () => {
    const row = await applyBest()
    return { ok: true, ip: row.ip, backup: row.backup }
  })
  ctx.registerIpc('clear', async () => {
    await clearBlock()
    return { ok: true }
  })
  ctx.registerIpc('install', () => installTask())

  ctx.onDispose(() => {
    disposed = true
    if (scanTimer) clearTimeout(scanTimer)
    scanTimer = null
  })

  scheduleScan(8000, true)
  log('已注册，数据目录：' + DATA_DIR)
}

async function open() {
  if (win && !win.isDestroyed()) {
    win.focus()
    return
  }
  const { BrowserWindow } = require('electron')
  win = new BrowserWindow({
    width: 620,
    height: 700,
    minWidth: 480,
    minHeight: 480,
    autoHideMenuBar: true,
    title: 'GitHub 入口 IP',
    backgroundColor: '#fff7fb',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  win.on('closed', () => {
    win = null
  })
  await win.loadFile(path.join(__dirname, 'ui.html'))
}

async function unregister() {
  disposed = true
  if (scanTimer) clearTimeout(scanTimer)
  scanTimer = null
  if (win && !win.isDestroyed()) win.close()
  win = null
}

module.exports = { register, open, unregister }
