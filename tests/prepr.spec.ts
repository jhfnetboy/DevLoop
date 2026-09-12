import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { blockedOnlyBySize, runPreprCheck } from '../src/prepr.ts'

/** A stand-in checker: prints `out` and exits with `code`, after recording its argv. */
async function fakeChecker(out: string, code: number, delayMs = 0): Promise<{ argv: string[], seen: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'prepr-'))
  const script = join(dir, 'check.mjs')
  const seen = join(dir, 'argv.json')
  await writeFile(script, `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)))
setTimeout(() => { process.stdout.write(${JSON.stringify(out)}); process.exit(${code}) }, ${delayMs})
`, 'utf8')
  return { argv: ['node', script], seen }
}

const json = (findings: object[], size: object = {}) => JSON.stringify({
  checker: { rules_version: '1.1.0', git_sha: 'abc', dirty: false },
  size: { lines: 12, files: 2, counted_top_dirs: ['src'], ...size },
  findings,
})
const block = (rule: string) => ({ rule, file: null, line: null, message: `${rule} hit`, severity: 'block' })
const review = (rule: string) => ({ rule, file: 'src/a.ts', line: 3, message: `${rule} hit`, severity: 'review' })

describe('running the pre-PR checker', () => {
  it('passes on exit 0, keeps review findings and the checker identity, and passes the task diff as argv', async () => {
    const { argv, seen } = await fakeChecker(json([review('B1')]), 0)
    const tree = await mkdtemp(join(tmpdir(), 'prepr-tree-'))
    const result = await runPreprCheck(argv, 'devloop', tree, 'a'.repeat(40), 5_000)
    expect(result.status).toBe('passed')
    expect(result.findings).toEqual([review('B1')])
    expect(result.checker).toEqual({ rulesVersion: '1.1.0', gitSha: 'abc', dirty: false })
    expect(result.size).toEqual({ lines: 12, files: 2, countedTopDirs: ['src'] })
    const { readFile } = await import('node:fs/promises')
    expect(JSON.parse(await readFile(seen, 'utf8'))).toEqual(['--base', 'a'.repeat(40), '--repo', tree, '--profile', 'devloop', '--json-only'])
  })

  it('blocks on exit 1 with a blocking finding, and knows when size alone blocked it', async () => {
    const sized = await runPreprCheck((await fakeChecker(json([block('SZ-1'), block('SZ-2'), review('T2')]), 1)).argv, 'devloop', tmpdir(), 'b', 5_000)
    expect(sized.status).toBe('blocked')
    expect(blockedOnlyBySize(sized)).toBe(true)
    const mixed = await runPreprCheck((await fakeChecker(json([block('SZ-1'), block('B2')]), 1)).argv, 'devloop', tmpdir(), 'b', 5_000)
    expect(blockedOnlyBySize(mixed)).toBe(false)
  })

  it('keeps a block found after hundreds of review notes, and never calls a block-free result size-only', async () => {
    const many = [...Array.from({ length: 250 }, (_, i) => review(`R${i}`)), block('B2')]
    const result = await runPreprCheck((await fakeChecker(json(many), 1)).argv, 'devloop', tmpdir(), 'b', 5_000)
    expect(result.status).toBe('blocked')
    expect(result.findings[0]).toEqual(block('B2'))
    expect(result.findings).toHaveLength(200)
    const clean = await runPreprCheck((await fakeChecker(json([review('B1')]), 0)).argv, 'devloop', tmpdir(), 'b', 5_000)
    expect(blockedOnlyBySize(clean)).toBe(false)
  })

  it('takes the size band and budget from the checker, and works the band out from the blocks when an older checker gives none', async () => {
    const limits = { max_lines: 200, elastic_lines: 260, max_files: 5, elastic_files: 6 }
    const elastic = await runPreprCheck((await fakeChecker(json([review('SZ-1')], { band: 'elastic', limits: { ...limits, note: 'x' } }), 0)).argv, 'devloop', tmpdir(), 'b', 5_000)
    expect(elastic).toMatchObject({ status: 'passed', band: 'elastic', limits })
    const over = await runPreprCheck((await fakeChecker(json([block('SZ-1')], { band: 'over' }), 1)).argv, 'devloop', tmpdir(), 'b', 5_000)
    expect(over).toMatchObject({ status: 'blocked', band: 'over', limits: null })

    const old = async (findings: object[], code: number) => (await runPreprCheck((await fakeChecker(json(findings), code)).argv, 'devloop', tmpdir(), 'b', 5_000)).band
    expect(await old([block('SZ-2')], 1)).toBe('over')
    expect(await old([block('B2')], 1)).toBe('normal')
    expect(await old([review('B1')], 0)).toBe('normal')
  })

  // Anything the checker cannot vouch for is unavailable, never a pass.
  it.each([
    ['exit 2 (usage or git error)', json([]), 2],
    ['exit 1 with no blocking finding', json([review('B1')]), 1],
    ['exit 0 with a blocking finding', json([block('B2')]), 0],
    ['output that is not JSON', 'Traceback (most recent call last)', 0],
    ['JSON without findings', JSON.stringify({ checker: {} }), 0],
    ['an over band that did not block', json([review('SZ-1')], { band: 'over' }), 0],
    ['an elastic band with a size block', json([block('SZ-1')], { band: 'elastic' }), 1],
  ])('reports %s as unavailable', async (_case, out, code) => {
    const result = await runPreprCheck((await fakeChecker(out, code)).argv, 'devloop', tmpdir(), 'b', 5_000)
    expect(result.status).toBe('unavailable')
    expect(result.detail).toBeTruthy()
  })

  it('reports a missing command, an empty argv and a timeout as unavailable', async () => {
    expect((await runPreprCheck(['/nonexistent/pre-pr-check.sh'], 'devloop', tmpdir(), 'b', 5_000)).status).toBe('unavailable')
    expect((await runPreprCheck([], 'devloop', tmpdir(), 'b', 5_000)).detail).toBe('no checker configured')
    const slow = await runPreprCheck((await fakeChecker(json([]), 0, 2_000)).argv, 'devloop', tmpdir(), 'b', 200)
    expect(slow).toMatchObject({ status: 'unavailable', detail: 'checker timed out' })
  })
})

// The contract against the checker itself, where it is installed (not in CI).
const REAL = join(process.env.HOME ?? '', 'Dev/tools/PR-daemon/scripts/pre-pr-check.sh')
describe.skipIf(!existsSync(REAL))('against the installed PR-daemon checker', () => {
  it('passes a small change and blocks an oversized one on size alone', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const git = (root: string, ...args: string[]) => promisify(execFile)('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
    const root = await mkdtemp(join(tmpdir(), 'prepr-real-'))
    await git(root, 'init', '-q', '-b', 'main')
    await git(root, 'commit', '-q', '--allow-empty', '-m', 'base')
    const base = (await git(root, 'rev-parse', 'HEAD')).stdout.trim()
    await writeFile(join(root, 'small.ts'), 'export const one = 1\n', 'utf8')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'small')
    expect((await runPreprCheck(['bash', REAL], 'devloop', root, base, 60_000)).status).toBe('passed')
    // Why --base must be the task's base: its head gives an empty diff, which passes anything.
    const head = (await git(root, 'rev-parse', 'HEAD')).stdout.trim()
    expect((await runPreprCheck(['bash', REAL], 'devloop', root, head, 60_000)).size?.lines).toBe(0)

    await writeFile(join(root, 'big.ts'), Array.from({ length: 300 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n', 'utf8')
    await git(root, 'add', '.')
    await git(root, 'commit', '-q', '-m', 'big')
    const big = await runPreprCheck(['bash', REAL], 'devloop', root, base, 60_000)
    expect(big.status).toBe('blocked')
    expect(blockedOnlyBySize(big)).toBe(true)
    expect(big.band).toBe('over')
    expect(big.checker?.rulesVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
