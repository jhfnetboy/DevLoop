import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { headlessPrompt, PLAN_CONTEXT } from '../src/dsh.ts'
import { inspectReadiness, parsePilotConfig, protectedPrefixes, readinessRefusal } from '../src/readiness.ts'
import { initGitRepo, mkdtempInRepo } from './helpers.ts'

const execFileAsync = promisify(execFile)
const git = (root: string, ...args: string[]) => execFileAsync('git', ['-C', root, ...args])

async function repoOn(branch: string | null, prefix: string): Promise<string> {
  const root = await realpath(await mkdtempInRepo(prefix))
  await initGitRepo(root)
  if (branch !== null) await git(root, 'switch', '-q', '-c', branch)
  return root
}

function check(readiness: Awaited<ReturnType<typeof inspectReadiness>>, id: string) {
  return readiness.checks.find(c => c.id === id)
}

describe('readiness to start a loop', () => {
  it('is ready on a clean work branch, and says what the planner will read', async () => {
    const root = await repoOn('devloop/feature', 'ready-ok-')
    await mkdir(join(root, 'docs', 'agent'), { recursive: true })
    await writeFile(join(root, 'docs', 'agent', 'tasks.md'), '# Tasks\n', 'utf8')
    await writeFile(join(root, 'docs', 'agent', 'roadmap.md'), '', 'utf8') // empty: not counted
    const r = await inspectReadiness(root)
    expect(r.ready).toBe(true)
    expect(r.branch).toBe('devloop/feature')
    expect(r.base).toBe('main')
    expect(readinessRefusal(r)).toBeNull()
    expect(check(r, 'plan')?.message).toContain('tasks.md')
    expect(check(r, 'plan')?.message).not.toContain('roadmap.md')
    // Advice, not a refusal: no .pilot.yml.
    expect(check(r, 'pilot')).toMatchObject({ ok: false, blocking: false })
  })

  it('refuses the trunk, because DevLoop would merge straight into it', async () => {
    const r = await inspectReadiness(await repoOn(null, 'ready-trunk-'))
    expect(r.ready).toBe(false)
    expect(check(r, 'trunk')).toMatchObject({ ok: false, blocking: true })
    expect(readinessRefusal(r)).toMatch(/switch -c devloop/)
  })

  it('refuses tracked changes, which every merge would refuse later; untracked files are fine', async () => {
    const root = await repoOn('work', 'ready-dirty-')
    await writeFile(join(root, 'scratch.txt'), 'untracked\n', 'utf8')
    expect((await inspectReadiness(root)).ready).toBe(true)
    await writeFile(join(root, 'README.md'), '# changed\n', 'utf8')
    const r = await inspectReadiness(root)
    expect(r.ready).toBe(false)
    expect(check(r, 'clean')?.message).toMatch(/1 个/)
  })

  it('still refuses the trunk when a tag has the same name as the branch', async () => {
    const root = await repoOn(null, 'ready-tag-')
    await git(root, 'tag', 'main') // makes `symbolic-ref --short HEAD` answer `heads/main`
    const r = await inspectReadiness(root)
    expect(r.branch).toBe('main')
    expect(check(r, 'trunk')).toMatchObject({ ok: false, blocking: true })
  })

  it('takes the trunk from origin/HEAD even when a local branch shadows its short name', async () => {
    const root = await repoOn('work', 'ready-origin-head-')
    await git(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD')
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
    await git(root, 'branch', 'origin/develop') // makes `--short` answer `remotes/origin/develop`
    expect((await inspectReadiness(root)).base).toBe('develop')
  })

  it('refuses a detached HEAD', async () => {
    const root = await repoOn('work', 'ready-detached-')
    await git(root, 'switch', '-q', '--detach')
    const r = await inspectReadiness(root)
    expect(r.branch).toBeNull()
    expect(check(r, 'branch')).toMatchObject({ ok: false, blocking: true })
    expect(r.ready).toBe(false)
  })

  it('takes the trunk and the planning directory from .pilot.yml', async () => {
    const root = await repoOn('develop', 'ready-pilot-')
    await writeFile(join(root, '.pilot.yml'), 'base_branch: develop   # trunk here\ndocs_dir: plans/\n', 'utf8')
    await mkdir(join(root, 'plans'))
    await writeFile(join(root, 'plans', 'roadmap.md'), '# M1\n', 'utf8')
    const r = await inspectReadiness(root)
    expect(r.base).toBe('develop')
    expect(r.docsDir).toBe('plans')
    expect(check(r, 'trunk')?.ok).toBe(false) // on develop, which .pilot.yml names as trunk
    expect(check(r, 'plan')?.message).toContain('roadmap.md')
  })

  it('still refuses main and master when .pilot.yml names another trunk', async () => {
    for (const trunk of ['main', 'master']) {
      const root = await repoOn(trunk === 'main' ? null : 'master', `ready-fallback-${trunk}-`)
      await writeFile(join(root, '.pilot.yml'), 'base_branch: develop\n', 'utf8')
      const r = await inspectReadiness(root)
      expect(r.base).toBe('develop')
      expect(r.branch).toBe(trunk)
      expect(check(r, 'trunk')).toMatchObject({ ok: false, blocking: true })
    }
  })

  it('refuses, rather than throws, for a root that is no longer a repository', async () => {
    const r = await inspectReadiness(await mkdtemp(join(tmpdir(), 'ready-gone-')))
    expect(r.ready).toBe(false)
    expect(r.checks).toEqual([expect.objectContaining({ id: 'repo', ok: false, blocking: true })])
    expect(readinessRefusal(r)).toMatch(/顶层/)
  })

  it('refuses the trunk under another case, and compares .pilot.yml bases case-folded', async (context) => {
    const root = await repoOn('work', 'ready-case-')
    const switched = await git(root, 'switch', '-q', 'Main').then(() => true, () => false)
    if (!switched) context.skip() // a case-sensitive filesystem: Main is not main
    const r = await inspectReadiness(root)
    expect(r.branch).toBe('Main')
    expect(check(r, 'trunk')).toMatchObject({ ok: false, blocking: true })
  })

  it('refuses a plain directory inside another repository, instead of borrowing its branch', async () => {
    const outer = await repoOn('work', 'ready-nested-')
    const inner = join(outer, 'sub')
    await mkdir(inner)
    const r = await inspectReadiness(inner)
    expect(r.ready).toBe(false)
    expect(r.branch).toBeNull()
    expect(r.checks.map(c => c.id)).toEqual(['repo'])
  })

  it('says so when planning is declared external, instead of reporting it missing', async () => {
    const root = await repoOn('work', 'ready-external-')
    await writeFile(join(root, '.pilot.yml'), 'base_branch: main\nplanning_source: external\n', 'utf8')
    const r = await inspectReadiness(root)
    expect(check(r, 'plan')).toMatchObject({ ok: true, blocking: false })
    expect(check(r, 'plan')?.message).toContain('仓库外')
  })

  it('never looks outside the repository through docs_dir', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ready-outside-'))
    await writeFile(join(outside, 'tasks.md'), '# secret plan\n', 'utf8')
    const root = await repoOn('work', 'ready-escape-')
    await symlink(outside, join(root, 'linked'))
    await writeFile(join(root, '.pilot.yml'), 'docs_dir: linked\n', 'utf8')
    expect(check(await inspectReadiness(root), 'plan')?.ok).toBe(false)

    await writeFile(join(root, '.pilot.yml'), `docs_dir: ../${outside.split('/').pop()}\n`, 'utf8')
    expect((await inspectReadiness(root)).docsDir).toBe('docs/agent')
  })

  it('ignores a symlinked .pilot.yml', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ready-pilot-link-'))
    await writeFile(join(outside, 'pilot.yml'), 'base_branch: work\n', 'utf8')
    const root = await repoOn('work', 'ready-pilot-link-')
    await symlink(join(outside, 'pilot.yml'), join(root, '.pilot.yml'))
    const r = await inspectReadiness(root)
    expect(check(r, 'pilot')?.ok).toBe(false)
    expect(r.base).toBe('main')
  })
})

describe('parsePilotConfig', () => {
  it('reads plain scalars and refuses anything it would have to guess at', () => {
    expect(parsePilotConfig('base_branch: main\nintegration_branch: main\ndocs_dir: docs/agent\n')).toEqual({
      baseBranch: 'main', docsDir: 'docs/agent', planningSource: null, protectPatterns: ['release', 'hotfix', 'deploy'], protectDropped: [],
    })
    expect(parsePilotConfig('base_branch: "main"\n').baseBranch).toBeNull()
    expect(parsePilotConfig('base_branch: main;rm\n').baseBranch).toBeNull()
    expect(parsePilotConfig('docs_dir: /etc\n').docsDir).toBeNull()
    expect(parsePilotConfig('docs_dir: a/../../b\n').docsDir).toBeNull()
    expect(parsePilotConfig('  base_branch: nested\n').baseBranch).toBeNull()
  })
})

describe('the planner prompt', () => {
  it('points every backend\'s planner at what the repository already says', () => {
    const prompt = headlessPrompt({ action: { type: 'plan' }, contract: null, workspaceRoot: '/repo', worktreeRoot: null })
    expect(prompt).toContain(PLAN_CONTEXT)
    for (const name of ['AGENTS.md', 'CLAUDE.md', '.pilot.yml', 'tasks.md', 'roadmap.md']) expect(prompt).toContain(name)
    expect(prompt).toContain('GOAL.md wins')
  })
})

describe('protect_patterns', () => {
  const floor = ['release', 'hotfix', 'deploy']
  const read = (text: string) => parsePilotConfig(text).protectPatterns

  it('reads the flow form, and keeps the floor however few a file names', () => {
    expect(read('protect_patterns: [release, "hotfix", ops]\n')).toEqual([...floor, 'ops'])
    expect(read('protect_patterns: [release]\n')).toEqual(floor)
    expect(read('')).toEqual(floor)
  })

  // Each row is a form pilot's ref hook reads; DevLoop must read at least as much.
  it.each([
    ['a blank line inside the list', 'protect_patterns:\n  - staging\n\n  - qa\nremote: origin\n'],
    ['a comment line inside the list', 'protect_patterns:\n  - staging\n  # reviewed weekly\n  - qa\n'],
    ['CRLF line endings', 'protect_patterns:\r\n  - staging\r\n  - qa\r\n'],
    ['items at column 0', 'protect_patterns:\n- staging\n- qa\nremote: origin\n'],
    ['a trailing comment on the key and on items', 'protect_patterns:   # extra\n  - staging # keep\n  - qa\n'],
  ])('reads %s', (_form, text) => {
    expect(read(text)).toEqual([...floor, 'staging', 'qa'])
  })

  it('keeps names git accepts, non-ASCII and + included, and stops at the next key', () => {
    expect(read('protect_patterns:\n  - 发布\n  - feat+x\nnext:\n  - not-protect\n')).toEqual([...floor, '发布', 'feat+x'])
  })

  it('reports what it cannot use instead of dropping it silently', () => {
    const config = parsePilotConfig('protect_patterns:\n  - "qa/*"\n  - bad..name\n  - ok\n')
    expect(config.protectPatterns).toEqual([...floor, 'ok'])
    expect(config.protectDropped).toEqual([
      { item: 'qa/*', reason: '通配符不起作用：保护按字面前缀匹配' },
      { item: 'bad..name', reason: '不是合法的分支名' },
    ])
  })

  it('applies the floor when a repository has no .pilot.yml at all', async () => {
    const root = await repoOn('work', 'ready-noprotect-')
    expect(await protectedPrefixes(root)).toEqual({ patterns: floor, dropped: [] })
  })
})
