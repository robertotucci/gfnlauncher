import { detectPadFamily, type PadFamily } from '@shared/padFamily'
import {
  parsePadId,
  type PadNumbering,
  type PadTransport,
  type PadTranslation
} from '@shared/padLayout'

export { translatePad } from '@shared/padLayout'
export type { PadNumbering, PadTranslation } from '@shared/padLayout'

/**
 * The room, as the Devices screen draws it.
 *
 * The *decision* about how to read each pad is `translatePad` in
 * `@shared/padLayout`, because the bridgeless preload has to make the same one
 * and cannot see anything under `@/`. What is left here is the part that is
 * only ever drawn: a name, a family, and which of the four ways a pad is being
 * read. Re-exported above so a component has one import rather than two.
 */

/** What the Devices screen draws for one controller. */
export interface PadInfo {
  /** Chromium's id. The key, and never drawn: it is a machine string. */
  readonly id: string
  /** The human half of it, which is what `/sys` calls the device too. */
  readonly name: string
  readonly family: PadFamily
  readonly transport: PadTransport
  readonly numbering: PadNumbering
}

export function padInfo(id: string, translation: PadTranslation): PadInfo {
  const identity = parsePadId(id)
  return {
    id,
    name: identity.name || 'Controller',
    family: detectPadFamily(identity),
    transport: translation.transport,
    numbering: translation.numbering
  }
}

/**
 * Whether two descriptions of the room are the same one.
 *
 * The poll loop builds a list of these sixty times a second and the Devices
 * screen renders it, so it goes into React state only when something actually
 * changed. Comparing the fields rather than the array identity is the whole of
 * what keeps a pad at rest from re-rendering the application.
 */
export function samePadInfo(first: readonly PadInfo[], second: readonly PadInfo[]): boolean {
  return (
    first.length === second.length &&
    first.every((pad, index) => {
      const other = second[index]
      return (
        other !== undefined &&
        pad.id === other.id &&
        pad.transport === other.transport &&
        pad.numbering === other.numbering
      )
    })
  )
}
