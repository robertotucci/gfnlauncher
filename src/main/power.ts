import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PowerAction, PowerResult } from '@shared/types'

const run = promisify(execFile)

/**
 * Ending the session from the sofa.
 *
 * `systemctl` rather than `loginctl` or a D-Bus binding: these three verbs are
 * the ones every desktop environment calls, they are mediated by logind and
 * polkit exactly the same way, and they need no native module — which matters,
 * because `npmRebuild: false` in electron-builder.yml and `externalizeDepsPlugin`
 * on the main bundle make adding one a build-config problem rather than an
 * `npm i`.
 *
 * Nothing here is privileged. If polkit wants to refuse, it refuses, and the
 * refusal comes back as an error the dialog can show rather than a silent
 * no-op — which on a screen with no keyboard is the only failure mode that
 * would be genuinely mystifying.
 */

/** The actions the bridge accepts, for validating whatever the renderer sends. */
const ACTIONS: readonly PowerAction[] = ['suspend', 'reboot', 'poweroff']

export function isPowerAction(value: unknown): value is PowerAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value)
}

/**
 * Pure, so the argv is unit-testable without ever putting the machine to sleep
 * — the same reason `buildLaunchArgv` exists in gfn/launch.ts.
 */
export function buildPowerArgv(action: PowerAction): [string, ...string[]] {
  return ['systemctl', action]
}

export async function runPowerAction(action: PowerAction): Promise<PowerResult> {
  const [command, ...argv] = buildPowerArgv(action)
  const printable = [command, ...argv].join(' ')

  try {
    await run(command, argv)
    return { ok: true, command: printable, error: null }
  } catch (error) {
    // systemctl puts the useful half of a polkit refusal on stderr, so prefer
    // it over the wrapper's "Command failed with exit code 1".
    const stderr = (error as { stderr?: string }).stderr?.trim()
    return {
      ok: false,
      command: printable,
      error: stderr || (error as Error).message
    }
  }
}
