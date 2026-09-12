import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendPrLog, readPrLog } from '../src/prlog.ts'

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

  it('keeps only the newest entries', async () => {
    const root = await project()
    for (let i = 0; i < 5; i += 1) await appendPrLog(root, review(`T${i}`), { error() {} })
    expect((await readPrLog(root, 2)).map(e => e.taskId)).toEqual(['T3', 'T4'])
  })
})
