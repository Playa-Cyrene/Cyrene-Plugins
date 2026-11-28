'use strict'

/**
 * cyrene-github-dns — 候选 IP 采集与探测
 *
 * 1. 从多个 DoH 源拿 github.com 的 A 记录，并加入一组兜底 IP
 * 2. 对每个 IP 做 TLS 握手（SNI = github.com），只留下证书匹配、2xx/3xx、未超时的
 *
 * 探测用 HEAD 请求，不下载正文；不经过系统 DNS，也不写任何东西。
 */

const https = require('node:https')
const dns = require('node:dns/promises')

const TARGET_HOST = 'github.com'

const DOH_SOURCES = [
  { name: '阿里', url: 'https://223.5.5.5/resolve?name=github.com&type=A' },
  { name: '腾讯', url: 'https://doh.pub/dns-query?name=github.com&type=A' },
  { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query?name=github.com&type=A' },
  { name: 'Google', url: 'https://dns.google/resolve?name=github.com&type=A' },
]

const FALLBACK_IPS = [
  '20.205.243.166',
  '20.27.177.113',
  '20.200.245.247',
  '20.233.83.145',
  '20.201.28.151',
  '20.248.137.48',
  '20.207.73.82',
  '20.175.192.147',
  '20.29.134.23',
  '140.82.112.3',
  '140.82.113.3',
  '140.82.114.3',
  '140.82.121.3',
]

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/

function isIPv4(value) {
  return IPV4.test(String(value || ''))
}

async function queryDoh(source, host) {
  const url = source.url.replace('name=github.com', 'name=' + encodeURIComponent(host))
  const response = await fetch(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(3500),
  })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const data = await response.json()
  const answers = Array.isArray(data && data.Answer) ? data.Answer : []
  return answers
    .filter((row) => row && Number(row.type) === 1 && isIPv4(row.data))
    .map((row) => String(row.data))
}

async function collectCandidates(host = TARGET_HOST) {
  const found = new Map()
  const errors = []

  const add = (ip, source) => {
    if (!isIPv4(ip)) return
    if (!found.has(ip)) found.set(ip, [])
    const list = found.get(ip)
    if (!list.includes(source)) list.push(source)
  }

  await Promise.all(
    DOH_SOURCES.map(async (source) => {
      try {
        const ips = await queryDoh(source, host)
        if (!ips.length) throw new Error('没有 A 记录')
        for (const ip of ips) add(ip, source.name)
      } catch (error) {
        errors.push(source.name + ': ' + String(error && error.message ? error.message : error))
      }
    })
  )

  for (const ip of FALLBACK_IPS) add(ip, '兜底')

  try {
    const systemIps = await dns.resolve4(host)
    for (const ip of systemIps) add(ip, '系统DNS')
  } catch (error) {
    errors.push('系统DNS: ' + String(error && error.message ? error.message : error))
  }

  return { ips: [...found.keys()], sources: Object.fromEntries(found), errors }
}

function probe(ip, options = {}) {
  const host = options.host || TARGET_HOST
  const timeout = Number(options.timeout) || 4000

  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const done = (row) => {
      if (settled) return
      settled = true
      resolve(row)
    }

    let req
    try {
      req = https.request(
        {
          host: ip,
          port: 443,
          method: 'HEAD',
          path: '/',
          servername: host,
          headers: {
            host,
            'user-agent': 'cyrene-github-dns/0.1',
            accept: 'text/html',
          },
          timeout,
          rejectUnauthorized: true,
        },
        (res) => {
          let san = ''
          try {
            const cert = res.socket && typeof res.socket.getPeerCertificate === 'function'
              ? res.socket.getPeerCertificate()
              : null
            san = cert && cert.subjectaltname ? String(cert.subjectaltname) : ''
          } catch {
            san = ''
          }
          res.resume()
          const sanOk = !san || san.includes(host)
          done({
            ip,
            ok: res.statusCode >= 200 && res.statusCode < 400 && sanOk,
            status: res.statusCode,
            ms: Date.now() - started,
            sanOk,
          })
        }
      )
    } catch (error) {
      done({ ip, ok: false, error: String(error && error.message ? error.message : error), ms: Date.now() - started })
      return
    }

    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (error) => {
      done({
        ip,
        ok: false,
        error: String(error && error.message ? error.message : error),
        ms: Date.now() - started,
      })
    })
    req.end()
  })
}

async function scan(options = {}) {
  const startedAt = Date.now()
  const host = options.host || TARGET_HOST
  const timeout = Number(options.timeout) || 4000
  const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 5))

  const collected = await collectCandidates(host)
  const rows = []
  let cursor = 0

  const worker = async () => {
    while (cursor < collected.ips.length) {
      const index = cursor
      cursor += 1
      const ip = collected.ips[index]
      const row = await probe(ip, { host, timeout })
      row.sources = collected.sources[ip] || []
      rows.push(row)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, collected.ips.length) }, () => worker())
  )

  rows.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1
    return (a.ms || 0) - (b.ms || 0)
  })

  return {
    host,
    rows,
    best: rows.find((row) => row.ok) || null,
    candidates: collected.ips.length,
    errors: collected.errors,
    scannedAt: startedAt,
    elapsedMs: Date.now() - startedAt,
  }
}

module.exports = { TARGET_HOST, isIPv4, collectCandidates, probe, scan }
