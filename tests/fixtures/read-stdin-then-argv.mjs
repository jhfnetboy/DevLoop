#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
writeFileSync(join(process.cwd(), 'argv.json'), JSON.stringify(process.argv.slice(2)))
writeFileSync(join(process.cwd(), 'stdin-eof.txt'), 'ok')
