// Dev orchestrator — spawns the Bun watcher and the Tailwind v4 watcher as
// children and forwards signals so Ctrl-C cleans up both.

const spawnChild = (cmd: string[], label: string): Bun.Subprocess => {
  const child = Bun.spawn(cmd, {
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  })
  child.exited.then((code) => {
    console.error(`[dev] ${label} exited with code ${code}`)
  })
  return child
}

const server = spawnChild(
  ['bun', '--watch', 'src/main.ts'],
  'server',
)

const css = spawnChild(
  [
    'bunx', '@tailwindcss/cli',
    '-i', 'src/ui/input.css',
    '-o', 'src/ui/dist.css',
    '--watch',
  ],
  'tailwind',
)

const cleanup = (): void => {
  for (const child of [server, css]) {
    try { child.kill() } catch { /* already exited */ }
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

// Stay alive until both children exit.
await Promise.all([server.exited, css.exited])
