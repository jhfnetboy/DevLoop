import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendPrLog, checkEntry, readPrLog } from '../src/prlog.ts'

const review = (taskId: string) => ({ kind: 'review' as const, at: '2026-09-12T00:00:00Z', taskId, head: null, verdict: 'PASS', reviewer: null })

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prlog-'))
  await mkdir(join(root, '.devloop'))
  return root
}

describe('the PR log', () => {
  it('appends lines and reads them back, skipping a torn or foreign line', async () => {
    const root = await project()
    const errors: unknown[] = []
    const log = { error: (_m: string, e: unknown) => { errors.push(e) } }
    await appendPrLog(root, review('T1'), log)
    await writeFile(join(root, '.devloop', 'PR-LOG.jsonl'), '{"torn":\nnot json\n', { flag: 'a' })
    await appendPrLog(root, review('T2'), log)
    expect((await readPrLog(root)).map(e => e.taskId)).toEqual(['T1', 'T2'])
    expect(errors).toEqual([])
  })

  it('never writes through a symlink, and says so instead of failing the loop', async () => {
    const root = await project()
    const target = join(await mkdtemp(join(tmpdir(), 'prlog-target-')), 'elsewhere')
    await writeFile(target, '', 'utf8')
    await symlink(target, join(root, '.devloop', 'PR-LOG.jsonl'))
    const errors: unknown[] = []
    await appendPrLog(root, review('T1'), { error: (_m: string, e: unknown) => { errors.push(e) } })
    expect(errors).toHaveLength(1)
    expect(await readFile(target, 'utf8')).toBe('')
    expect(await readPrLog(root)).toEqual([])
  })

  it('drops the partial line a long file\'s tail starts in, and never reads through a symlinked .devloop', async () => {
    const root = await project()
    const padded = { ...review('BIG'), reviewer: 'x'.repeat(300 * 1024) } // one line longer than the tail window
    await appendPrLog(root, padded, { error() {} })
    await appendPrLog(root, review('T1'), { error() {} })
    expect((await readPrLog(root)).map(e => e.taskId)).toEqual(['T1'])

    // A last line exactly as long as the window, so the window begins on a line boundary: it must survive.
    const aligned = await project()
    await appendPrLog(aligned, review('FIRST'), { error() {} })
    const bare = `${JSON.stringify({ ...review('EDGE'), reviewer: '' })}\n`
    await appendPrLog(aligned, { ...review('EDGE'), reviewer: 'y'.repeat(256 * 1024 - Buffer.byteLength(bare)) }, { error() {} })
    expect((await readPrLog(aligned)).map(e => e.taskId)).toEqual(['EDGE'])

    const elsewhere = await mkdtemp(join(tmpdir(), 'prlog-linked-'))
    await mkdir(join(elsewhere, '.devloop'))
    await appendPrLog(elsewhere, review('OUT'), { error() {} })
    const linked = await mkdtemp(join(tmpdir(), 'prlog-root-'))
    await symlink(join(elsewhere, '.devloop'), join(linked, '.devloop'))
    expect(await readPrLog(linked)).toEqual([])
  })

  it('drops a line with a kind and a task but not the rest of the shape, and keeps the good ones', async () => {
    const root = await project()
    const good = { kind: 'check', at: '2026-09-12T00:00:00Z', taskId: 'OK', head: null, status: 'passed', size: { lines: 3, files: 1, countedTopDirs: ['src'] }, rules: [], blocking: [], checker: null }
    const bad = [
      { kind: 'check', taskId: 'X' }, // what took the page down
      { ...good, taskId: 'B1', status: 'maybe' },
      { ...good, taskId: 'B2', blocking: 'SZ-1' },
      { ...good, taskId: 'B3', size: { lines: '3', files: 1, countedTopDirs: [] } },
      { kind: 'review', at: 'x', taskId: 'B4', head: null },
      { ...good, taskId: 'B5', head: 7 }, // the page slices head
      { ...good, taskId: 'B6', at: undefined },
      { ...good, taskId: 'B7', band: 'huge' },
    ]
    await writeFile(join(root, '.devloop', 'PR-LOG.jsonl'), [good, ...bad, { ...good, taskId: 'E', band: 'elastic' }, review('R')].map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')
    expect((await readPrLog(root)).map(e => e.taskId)).toEqual(['OK', 'E', 'R'])
  })

  it('records the size band of a check, so the budget can be judged on how often it was stretched', () => {
    const result = { status: 'passed', findings: [{ rule: 'SZ-1', file: null, line: null, message: '', severity: 'review' }], size: { lines: 230, files: 4, countedTopDirs: ['src'] }, band: 'elastic', limits: null, checker: null, detail: null } as const
    expect(checkEntry('T1', null, result, 0)).toMatchObject({ kind: 'check', band: 'elastic', rules: ['SZ-1'], blocking: [] })
  })

  it('keeps only the newest entries', async () => {
    const root = await project()
    for (let i = 0; i < 5; i += 1) await appendPrLog(root, review(`T${i}`), { error() {} })
    expect((await readPrLog(root, 2)).map(e => e.taskId)).toEqual(['T3', 'T4'])
  })
})
