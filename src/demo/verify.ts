/**
 * Verification runner
 *
 * Wraps the two most important local verification steps into one command:
 *
 *   pnpm run verify
 */

import { execFileSync } from 'child_process'

function runStep(title: string, cmd: string, args: string[]): void {
  console.log()
  console.log(`== ${title} ==`)
  execFileSync(cmd, args, {
    stdio: 'inherit',
    env: process.env,
  })
}

console.log('DARWIN verification')
console.log('This command runs the fastest local verification path.')

runStep('Build', 'pnpm', ['build'])
runStep('Strategy integration test', 'pnpm', ['test:strategies'])

console.log()
console.log('Verification complete.')
