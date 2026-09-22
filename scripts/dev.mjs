import { spawn } from 'node:child_process'

const processes = [
  spawn(process.execPath, ['app/server/index.mjs'], { stdio: 'inherit' }),
  spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--host', '127.0.0.1'], { stdio: 'inherit' }),
]

function stop() {
  for (const child of processes) child.kill('SIGTERM')
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const child of processes) child.on('exit', code => { if (code && code !== 143) process.exitCode = code })
