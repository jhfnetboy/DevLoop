#!/usr/bin/env node
import { runCli } from '../command.js'

// Unconditional: a package-manager shim invokes this through a path that need
// not match `import.meta.url`, and a guard that guesses wrong exits 0 in
// silence — which is how an operator concludes the loop is fine when it is not.
runCli(process.argv.slice(2)).then(
  result => {
    process.stdout.write(result.out)
    process.stderr.write(result.err)
    process.exitCode = result.code
  },
  error => {
    process.stderr.write(`devloop: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
