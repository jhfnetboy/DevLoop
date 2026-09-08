const keys = process.argv.slice(2)
const seen = Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]))
process.stdout.write(JSON.stringify(seen))
