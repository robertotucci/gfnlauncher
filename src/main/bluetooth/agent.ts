import type { InterfaceDescriptor } from '@homebridge/dbus-native'
import type { BluetoothPairingRequest } from '@shared/types'
import type { BluezBus } from './bluez'

/**
 * The thing BlueZ asks when a pairing needs a human.
 *
 * ── Why the launcher has one at all ─────────────────────────────────────────
 *
 * BlueZ does not pair on its own. It hands the interactive part of the exchange
 * to an *agent* — a D-Bus object the pairing client publishes — and with no
 * agent available a pairing that needs any confirmation simply fails. The
 * desktop has one (bluedevil, gnome-shell); relying on it would mean the dialog
 * appears on a desktop the launcher is covering, with a pointer nobody has.
 *
 * ── Why it lives for five seconds ───────────────────────────────────────────
 *
 * It is registered immediately before `Device1.Pair` and unregistered in a
 * `finally`, and that scope is the design rather than tidiness. Registering it
 * for the session would mean two things nobody asked for: `RequestDefaultAgent`
 * makes us the answer to *incoming* pairings, so a phone trying to pair with
 * this machine would raise a confirmation on a launcher that was showing a game
 * grid; and the desktop's own agent would stay displaced for the whole evening
 * rather than for the length of one press. On unregister BlueZ hands the
 * default back to another registered agent on its own.
 *
 * ── The capability, and the one thing it cannot do ──────────────────────────
 *
 * `DisplayYesNo`. It covers the three cases a television can actually answer:
 * "just works" pairing, which BlueZ completes without asking; numeric
 * comparison, which is six digits and an A; and a passkey to type on the *other*
 * device, which is a number to read out.
 *
 * It does not cover `RequestPinCode` and `RequestPasskey`, which ask the
 * launcher to *type* a code — and a pad cannot. Those are refused, with a
 * sentence saying so. `NoInputNoOutput` would have made them unreachable by
 * forcing every pairing down the "just works" path, and it would also have
 * silently downgraded the security of pairings that could have been confirmed
 * properly. Refusing the two the hardware cannot do beats weakening the ones it
 * can — and a control that silently does nothing is the failure this codebase
 * refuses everywhere else.
 */

/**
 * Where the agent is published.
 *
 * Not the application id: a D-Bus object path allows `[A-Za-z0-9_]` and `/`
 * only, so the dots have to become slashes or the export is rejected.
 */
export const AGENT_PATH = '/io/github/robertotucci/GfnLauncher/bt_agent'

const AGENT_IFACE = 'org.bluez.Agent1'
const AGENT_MANAGER_IFACE = 'org.bluez.AgentManager1'
const AGENT_MANAGER_PATH = '/org/bluez'
const CAPABILITY = 'DisplayYesNo'

/** BlueZ's own name for "the user said no", which ends a pairing cleanly. */
const REJECTED = 'org.bluez.Error.Rejected'
const CANCELED = 'org.bluez.Error.Canceled'

function refuse(name: string, message: string): never {
  throw Object.assign(new Error(message), { dbusName: name })
}

/** Six digits, zero-padded, which is how both ends of a pairing display it. */
export function formatPasskey(passkey: unknown): string {
  const value = typeof passkey === 'number' && Number.isFinite(passkey) ? passkey : 0
  return String(Math.abs(Math.trunc(value))).padStart(6, '0')
}

export interface AgentHooks {
  /** The device behind an object path, or null if the mirror has never seen it. */
  describe(devicePath: string): { address: string; name: string } | null
  /**
   * Puts a confirmation on screen and resolves with the answer.
   *
   * BlueZ is holding its `Pair` call open for as long as this takes, which is
   * why the screen shows the band the moment it appears and why leaving the
   * screen answers it rather than abandoning it.
   */
  confirm(request: BluetoothPairingRequest): Promise<boolean>
  /** Puts a code on screen for the user to type on the other device. */
  display(request: BluetoothPairingRequest): void
  /** The request is over, however it ended. */
  clear(): void
}

export interface PairingAgent {
  /**
   * Registers the agent, runs the pairing, and unregisters whatever happened.
   *
   * Unregistering is in a `finally` rather than after the call because the
   * failure that matters is the one where `Pair` throws: an agent left
   * registered by a failed pairing is one that answers the *next* incoming
   * request, on a screen the user has already left.
   */
  during<T>(run: () => Promise<T>): Promise<T>
}

export function createPairingAgent(bus: BluezBus, hooks: AgentHooks): PairingAgent {
  /**
   * The device paths this agent is being asked about, resolved to something the
   * screen can name. A path the mirror does not know still has to produce a
   * row, or the confirmation would be an unattributed six-digit number.
   */
  const named = (devicePath: unknown): { address: string; name: string } => {
    const path = typeof devicePath === 'string' ? devicePath : ''
    return hooks.describe(path) ?? { address: '', name: 'A Bluetooth device' }
  }

  const implementation = {
    /** BlueZ has taken the agent away — usually because we unregistered it. */
    Release(): void {
      hooks.clear()
    },

    /** The pairing was called off from the other side. */
    Cancel(): void {
      hooks.clear()
    },

    async RequestConfirmation(devicePath: unknown, passkey: unknown): Promise<void> {
      const { address, name } = named(devicePath)
      try {
        const accepted = await hooks.confirm({
          address,
          name,
          kind: 'confirm',
          passkey: formatPasskey(passkey)
        })
        if (!accepted) refuse(REJECTED, 'The user did not confirm the code.')
      } finally {
        hooks.clear()
      }
    },

    /**
     * The user initiated this by pressing A on a row, so there is nothing left
     * to ask. Returning is the acceptance.
     */
    RequestAuthorization(): void {},

    AuthorizeService(): void {},

    /** A number to key into the other device. Nothing here to press. */
    DisplayPasskey(devicePath: unknown, passkey: unknown): void {
      const { address, name } = named(devicePath)
      hooks.display({ address, name, kind: 'display', passkey: formatPasskey(passkey) })
    },

    DisplayPinCode(devicePath: unknown, pincode: unknown): void {
      const { address, name } = named(devicePath)
      hooks.display({
        address,
        name,
        kind: 'display',
        passkey: typeof pincode === 'string' ? pincode : ''
      })
    },

    /**
     * The two a gamepad cannot answer.
     *
     * Both want a code typed *into this machine*, and the launcher has no
     * keyboard on this screen. Refusing names the limit; pretending would end
     * as a pairing that hangs until BlueZ times it out.
     */
    RequestPinCode(): never {
      refuse(
        CANCELED,
        'This device wants a PIN typed on the computer, which this screen cannot do. ' +
          'Pair it from the desktop’s own Bluetooth settings.'
      )
    },

    RequestPasskey(): never {
      refuse(
        CANCELED,
        'This device wants a passkey typed on the computer, which this screen cannot do. ' +
          'Pair it from the desktop’s own Bluetooth settings.'
      )
    }
  }

  /**
   * Every member here must exist on `implementation`: dbus-native does not
   * check at export time, and a missing one answers `UnknownMethod` at call
   * time — which presents as a pairing that fails for no stated reason.
   */
  const descriptor: InterfaceDescriptor = {
    name: AGENT_IFACE,
    methods: {
      Release: ['', ''],
      RequestPinCode: ['o', 's'],
      DisplayPinCode: ['os', ''],
      RequestPasskey: ['o', 'u'],
      DisplayPasskey: ['ouq', ''],
      RequestConfirmation: ['ou', ''],
      RequestAuthorization: ['o', ''],
      AuthorizeService: ['os', ''],
      Cancel: ['', '']
    }
  }

  // Published once for the connection. Registration, which is what BlueZ acts
  // on, is what comes and goes below.
  bus.exportInterface(implementation, AGENT_PATH, descriptor)

  const manage = (member: string, body: unknown[], signature: string): Promise<unknown[]> =>
    bus.invoke(AGENT_MANAGER_PATH, AGENT_MANAGER_IFACE, member, signature, body)

  return {
    async during(run) {
      await manage('RegisterAgent', [AGENT_PATH, CAPABILITY], 'os')
      try {
        // Ours answers the pairing we are about to start; the default is what
        // BlueZ falls back to for anything it cannot attribute to a caller.
        // Both are given back below.
        await manage('RequestDefaultAgent', [AGENT_PATH], 'o').catch((error: unknown) => {
          // Not fatal. An agent registered by this connection is still the one
          // BlueZ prefers for a pairing this connection asked for, so losing
          // the default only costs the unattributable cases.
          console.warn('BlueZ would not make the launcher the default pairing agent:', error)
        })
        return await run()
      } finally {
        hooks.clear()
        try {
          await manage('UnregisterAgent', [AGENT_PATH], 'o')
        } catch (error) {
          // Worth a line rather than a throw: the pairing itself has already
          // been decided, and the cost of this failing is an agent that stays
          // registered until the launcher quits — which is a behaviour change,
          // not a broken pairing.
          console.warn('The Bluetooth pairing agent could not be unregistered:', error)
        }
      }
    }
  }
}
