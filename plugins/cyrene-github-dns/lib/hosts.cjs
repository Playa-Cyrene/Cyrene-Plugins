'use strict'

/**
 * hosts 标记块：只碰自己块里的内容，块外原样保留。
 * 真正的落盘由 scripts/apply-hosts.ps1 在计划任务里完成（需要管理员）。
 */

const DOMAINS = ['github.com', 'www.github.com']

function buildBlock(ip, markStart, markEnd, domains = DOMAINS) {
  return [markStart, ...domains.map((domain) => ip + ' ' + domain), markEnd].join('\n')
}

function stripBlock(text, markStart, markEnd) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  let inside = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === markStart) {
      inside = true
      continue
    }
    if (trimmed === markEnd) {
      inside = false
      continue
    }
    if (!inside) out.push(line)
  }
  return out.join('\n')
}

function applyBlock(text, ip, markStart, markEnd, domains = DOMAINS) {
  const base = stripBlock(text, markStart, markEnd).replace(/\s+$/, '')
  return (base ? base + '\n\n' : '') + buildBlock(ip, markStart, markEnd, domains) + '\n'
}

function readBlock(text, markStart, markEnd) {
  const lines = String(text || '').split(/\r?\n/)
  const domains = []
  let ip = ''
  let inside = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === markStart) {
      inside = true
      continue
    }
    if (trimmed === markEnd) {
      inside = false
      continue
    }
    if (!inside || !trimmed || trimmed.startsWith('#')) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length >= 2 && /^\d+\.\d+\.\d+\.\d+$/.test(parts[0])) {
      ip = parts[0]
      domains.push(parts[1])
    }
  }
  return ip ? { ip, domains } : null
}

module.exports = { DOMAINS, buildBlock, stripBlock, applyBlock, readBlock }
