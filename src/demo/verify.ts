/**
 * Verification runner
 *
 * Wraps the two most important local verification steps into one command:
 *
 *   pnpm run verify
 */

import { execFileSync } from 'child_process'

function runStep(title: string, cmd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): void {
  console.log()
  console.log(`== ${title} ==`)
  execFileSync(cmd, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv,
    },
  })
}

console.log('DARWIN verification')
console.log('This command runs the fastest local verification path.')
console.log('Note: this path validates the environment-backed OKX demo flow and expects configured demo credentials.')
console.log('For the zero-key deterministic walkthrough, run: pnpm run proof')

runStep('Build', 'pnpm', ['build'])
runStep('Strategy integration test', 'pnpm', ['test:strategies'], { DARWIN_LANG: 'en' })

console.log()
console.log('Verification complete.')
