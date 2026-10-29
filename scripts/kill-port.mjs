#!/usr/bin/env node
// Frees a TCP port before `npm run dev` / `be` / `fe`: kills whatever is LISTENING on it.
// Usage: node scripts/kill-port.mjs 8080 [5173 ...]
//
// Replaces `npx kill-port`, which on macOS ran `lsof -i -P` over every socket on the
// machine without `-n`. lsof then reverse-DNS-resolved each connection and could hang
// for minutes, so `npm run dev` sat there doing nothing. Here we ask only for the
// listening socket on the given port, with -n (no DNS) and -P (no port names).
import { execFileSync } from 'node:child_process'

const ports = process.argv.slice(2).map(Number).filter(p => Number.isInteger(p) && p > 0)
if (!ports.length) {
  console.error('usage: node scripts/kill-port.mjs <port> [port...]')
  process.exit(1)
}

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
  } catch (e) {
    return e.stdout ?? '' // lsof exits 1 when nothing matches
  }
}

const pidsOn = (port) => {
  if (process.platform === 'win32') {
    return run('netstat', ['-ano', '-p', 'TCP'])
      .split(/\r?\n/)
      .filter(l => /LISTENING/i.test(l) && new RegExp(`:${port}\\s`).test(l))
      .map(l => l.trim().split(/\s+/).pop())
  }
  return run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).split(/\s+/)
}

for (const port of ports) {
  const pids = [...new Set(pidsOn(port).filter(p => /^\d+$/.test(p) && Number(p) !== process.pid))]
  if (!pids.length) {
    console.log(`port ${port}: free`)
    continue
  }
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') run('taskkill', ['/PID', pid, '/F'])
      else process.kill(Number(pid), 'SIGKILL')
      console.log(`port ${port}: killed process ${pid}`)
    } catch (e) {
      console.log(`port ${port}: could not kill process ${pid} (${e.code ?? e.message})`)
    }
  }
}
