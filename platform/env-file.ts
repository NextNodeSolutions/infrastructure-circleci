// Turns the vault's JSON export, read on stdin, into shell exports on stdout, one per
// secret, each value a single-quoted literal. The names go to stderr for the job log;
// the values never do.
import { text } from 'node:stream/consumers'

import { secretsOf } from './src/adapters/infisical/export.ts'
import { emitExports } from './src/adapters/shell/exports.ts'

emitExports(secretsOf(await text(process.stdin)))
