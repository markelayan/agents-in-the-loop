// One source for the package, MCP handshake, and startup version.
import { readFileSync } from 'node:fs'

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
