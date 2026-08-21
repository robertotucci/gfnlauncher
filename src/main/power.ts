import type { PowerAction, PowerResult } from '@shared/types'
import { classifyHostFailure, hostCommand, hostExecFile, printableCommand } from './host'

/**
 * Ending the session from the sofa.
 *
 * A command rather than a D-Bus binding: these three verbs are the ones every
 * desktop environment calls, they are mediated by logind and polkit exactly the
 * same way, and they need no native module — which matters, because
 * `npmRebuild: false` in electron-builder.yml and `externalizeDepsPlugin` on the
 * main bundle make adding one a build-config problem rather than an `npm i`.
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
 *
 * ── Two tools, and the second one only when the first is not there ──────────
 *
 * `systemctl` first, because on a systemd machine it is the command every
 * desktop's own power menu runs. `loginctl` is the fallback and it is not a
 * synonym: it is what elogind ships, which is how the same three verbs are
 * reached on a distribution that has logind without systemd — Artix, Void,
 * Devuan. Both end at the same place, `org.freedesktop.login1`.
 *
 * **Only a `missing` classification falls through**, and that restraint is the
 * whole of the design. A polkit refusal is a real answer, arrived at by asking
 * the right service the right question; retrying it through a second command
 * would ask the same service the same question, be refused identically, and
 * report the second refusal — hiding which tool was used and doubling the wait
 * in front of somebody who pressed a button. Only "there is no such binary" is
 * a reason to try another one.
 */

/** The actions the bridge accepts, for validating whatever the renderer sends. */
const ACTIONS: readonly PowerAction[] = ['suspend', 'reboot', 'poweroff']

/**
 * The two commands, in the order they are tried.
 *
 * A list rather than two branches, so the fallback loop below cannot fall out
 * of step with the argv builder, and so a third one would be a row.
 */
export const POWER_TOOLS = ['systemctl', 'loginctl'] as const
export type PowerTool = (typeof POWER_TOOLS)[number]

export function isPowerAction(value: unknown): value is PowerAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value)
}

/**
 * Pure, so the argv is unit-testable without ever putting the machine to sleep
 * — the same reason `buildLaunchArgv` exists in gfn/launch.ts.
 *
 * The verbs are deliberately identical across both tools: `suspend`, `reboot`
 * and `poweroff` are spelled the same to `systemctl` and to `loginctl`, which
 * is what lets one action be one word and the tool be the only variable.
 */
export function buildPowerArgv(
  action: PowerAction,
  tool: PowerTool = 'systemctl'
): [string, ...string[]] {
  return [tool, action]
}

export async function runPowerAction(action: PowerAction): Promise<PowerResult> {
  let last: PowerResult | null = null

  for (const tool of POWER_TOOLS) {
    const [command, ...argv] = buildPowerArgv(action, tool)
    // The argv as it will actually run, flatpak-spawn prefix and all: this
    // string is shown in the dialog beside the failure, and half of one is a
    // worse starting point than none.
    const printable = printableCommand(...hostCommand(command, argv))

    try {
      await hostExecFile(command, argv)
      return { ok: true, command: printable, error: null }
    } catch (error) {
      // `classifyHostFailure` already prefers the tool's own stderr — which is
      // where the useful half of a polkit refusal lives — over the wrapper's
      // "Command failed with exit code 1", and adds the one message this path
      // could not otherwise produce: that a sandboxed launcher was never
      // allowed to ask the host in the first place.
      const failure = classifyHostFailure(error)
      last = { ok: false, command: printable, error: failure.message }

      // Anything but "no such binary" is this machine's real answer, and the
      // user is owed it rather than a second attempt at the same question.
      if (failure.kind !== 'missing') return last

      console.warn(`${command} is not on this machine; trying the next power tool.`)
    }
  }

  // Every tool was missing. The last message is the one to show, since the
  // dialog has room for one command and the last is the last thing tried.
  return last ?? { ok: false, command: action, error: 'No way to end the session was found.' }
}
