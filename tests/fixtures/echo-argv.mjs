#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

writeFileSync(join(process.cwd(), 'argv.json'), JSON.stringify(process.argv.slice(2)))
