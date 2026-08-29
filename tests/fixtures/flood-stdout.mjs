#!/usr/bin/env node
const chunk = Buffer.alloc(64 * 1024, 0x61)
while (true) {
  process.stdout.write(chunk)
}
