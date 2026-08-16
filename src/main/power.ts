import type { PowerAction, PowerResult } from '@shared/types'
import { classifyHostFailure, hostCommand, hostExecFile, printableCommand } from './host'

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
 *
 * Packaged as a Flatpak there is no `systemctl` in the sandbox at all, so the
 * call goes out through `host.ts`. That changes where the command runs and
 * nothing about what it is: `buildPowerArgv` still produces the same two words,
 * and is still pure so the suite can assert them without suspending the machine
 * running it.
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
  // The argv as it will actually run, flatpak-spawn prefix and all: this string
  // is shown in the dialog beside the failure, and half of one is a worse
  // starting point than none.
  const printable = printableCommand(...hostCommand(command, argv))

  try {
    await hostExecFile(command, argv)
    return { ok: true, command: printable, error: null }
  } catch (error) {
    // `classifyHostFailure` already prefers systemctl's own stderr — which is
    // where the useful half of a polkit refusal lives — over the wrapper's
    // "Command failed with exit code 1", and adds the one message this path
    // could not otherwise produce: that a sandboxed launcher was never allowed
    // to ask the host in the first place.
    return { ok: false, command: printable, error: classifyHostFailure(error).message }
  }
}
