import { detectPadFamily, type PadFamily } from '@shared/padFamily'
import { parsePadId } from '@shared/padLayout'

/**
 * Which glyph set the footer legend speaks.
 *
 * Not a hardware fact: it is whatever the user last touched. A pad left
 * connected but idle while someone types must not have the legend naming
 * buttons nobody is pressing — across a dim room the legend is the only
 * instruction manual there is, so it has to describe the device in hand.
 *
 * The families themselves live in `@shared/padFamily`, because the footer is
 * not the only surface that names a button: the cursor hint drawn into NVIDIA's
 * page and the badges on both on-screen keyboards need the same answer, and
 * main works it out from `/sys` rather than from a `Gamepad.id`. This module is
 * the renderer's doorway to it and nothing else.
 */
export type InputScheme = 'keyboard' | PadFamily

export type PadScheme = PadFamily

/** The family of the pad Chromium describes with this id. */
export function detectPadScheme(id: string): PadScheme {
  return detectPadFamily(parsePadId(id))
}
