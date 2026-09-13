import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { runPreprCheck } from '../src/prepr.ts'
import { validateProjectRoot } from '../src/projects.ts'
import { hostGit } from '../src/worktree.ts'

const run = promisify(execFile)
const SAVED = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE }
afterEach(() => {
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

async function repo(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'host-git-')))
  await run('git', ['-C', root, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', root])
  return root
}

describe('the git this host runs', () => {
  it('reads the repository it was given, whatever git paths it inherited', async () => {
    const [mine, other] = [await repo(), await repo()]
    const head = (await run('git', ['-C', mine, 'rev-parse', 'HEAD'])).stdout.trim()
    process.env.GIT_DIR = join(other, '.git')
    process.env.GIT_WORK_TREE = other
    expect((await hostGit(mine, ['rev-parse', 'HEAD'])).trim()).toBe(head)
    // Registering a project asks git for its toplevel the same way.
    await mkdir(join(mine, '.devloop'))
    await expect(validateProjectRoot(mine)).resolves.toBe(mine)
  })

  it('runs no hook unless the caller keeps the repository\'s own', async () => {
    const root = await repo()
    const marker = join(root, 'hook-ran')
    await writeFile(join(root, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch "${marker}"\n`)
    await chmod(join(root, '.git', 'hooks', 'pre-commit'), 0o755)
    const commit = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']
    await hostGit(root, commit)
    expect(existsSync(marker)).toBe(false)
    await hostGit(root, commit, { repoHooks: true })
    expect(existsSync(marker)).toBe(true)
  })

  it('hands the pre-PR checker no hooks and no fsmonitor to run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'host-git-check-'))
    const seen = join(dir, 'env.json')
    await writeFile(join(dir, 'check.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ params: process.env.GIT_CONFIG_PARAMETERS, dir: process.env.GIT_DIR ?? null }))
process.stdout.write(JSON.stringify({ checker: { rules_version: '1', git_sha: 'a', dirty: false }, size: { lines: 1, files: 1, counted_top_dirs: [] }, findings: [] }))
`)
    process.env.GIT_DIR = '/elsewhere/.git'
    await runPreprCheck(['node', join(dir, 'check.mjs')], 'devloop', dir, 'a'.repeat(40), 10_000)
    const env = JSON.parse(await readFile(seen, 'utf8'))
    expect(env.params).toContain("'core.fsmonitor=false'")
    expect(env.params).toMatch(/'core\.hooksPath=(\/dev\/null|NUL)'/)
    expect(env.dir).toBeNull()
  })
})
