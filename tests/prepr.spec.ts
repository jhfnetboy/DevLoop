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

const json = (findings: object[]) => JSON.stringify({
  checker: { rules_version: '1.1.0', git_sha: 'abc', dirty: false },
  size: { lines: 12, files: 2, counted_top_dirs: ['src'] },
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

  // Anything the checker cannot vouch for is unavailable, never a pass.
  it.each([
    ['exit 2 (usage or git error)', json([]), 2],
    ['exit 1 with no blocking finding', json([review('B1')]), 1],
    ['exit 0 with a blocking finding', json([block('B2')]), 0],
    ['output that is not JSON', 'Traceback (most recent call last)', 0],
    ['JSON without findings', JSON.stringify({ checker: {} }), 0],
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
