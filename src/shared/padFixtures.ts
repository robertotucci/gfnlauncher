import { EV_ABS, EV_DPAD, EV_KEY, joydevLayout, type PadProfile } from './padLayout'

/**
 * Real pads, as the kernel declares them.
 *
 * A source module rather than a block inside one test file, because two suites
 * need the same devices — `padLayout.test.ts` for the translation and
 * `evdev.test.ts` for the reader — and a second copy of a capability list is a
 * second thing to keep true. Nothing in the application imports this, so it
 * never reaches a bundle; the precedent is `src/main/gfn/fixtures.ts`.
 *
 * Codes rather than printed bitmaps, because the *ordering* is what is under
 * test in both places; `parseCapabilityBitmap` gets the real strings in its own
 * tests.
 */
export interface PadFixture {
  readonly name: string
  readonly vendor: string
  readonly product: string
  readonly keys: readonly number[]
  readonly abs: readonly number[]
}

/** An Xbox 360 pad on `xpad`, the USB driver. */
export const XPAD_USB: PadFixture = {
  name: 'Microsoft X-Box 360 pad',
  vendor: '045e',
  product: '028e',
  keys: [
    EV_KEY.a,
    EV_KEY.b,
    EV_KEY.x,
    EV_KEY.y,
    EV_KEY.lb,
    EV_KEY.rb,
    EV_KEY.select,
    EV_KEY.start,
    EV_KEY.mode,
    EV_KEY.l3,
    EV_KEY.r3
  ],
  abs: [EV_ABS.x, EV_ABS.y, EV_ABS.z, EV_ABS.rx, EV_ABS.ry, EV_ABS.rz, EV_ABS.hat0x, EV_ABS.hat0y]
}

/**
 * An Xbox pad over Bluetooth, on `hid-microsoft`. Read off a real one:
 * `/sys/class/input/js0/device/capabilities/key` = `7fff000000000000 0
 * 8000000000 0 0`. It declares the four codes xpad leaves out — BTN_C, BTN_Z,
 * BTN_TL2, BTN_TR2 — and every one of them shifts the stick clicks along.
 */
export const XBOX_BLUETOOTH: PadFixture = {
  name: 'Xbox Wireless Controller',
  vendor: '045e',
  product: '0b13',
  keys: [
    0x130, 0x131, 0x132, 0x133, 0x134, 0x135, 0x136, 0x137, 0x138, 0x139, 0x13a, 0x13b, 0x13c,
    0x13d, 0x13e
  ],
  // ABS_GAS and ABS_BRAKE are the triggers here, and ABS_RX/ABS_RY are absent
  // entirely: the right stick is on ABS_Z and ABS_RZ.
  abs: [EV_ABS.x, EV_ABS.y, EV_ABS.z, EV_ABS.rz, 0x09, 0x0a, EV_ABS.hat0x, EV_ABS.hat0y]
}

/** A DualSense on `hid-playstation`, which puts its d-pad on four buttons. */
export const DUALSENSE: PadFixture = {
  name: 'Sony Interactive Entertainment Wireless Controller',
  vendor: '054c',
  product: '0ce6',
  keys: [
    0x130, 0x131, 0x133, 0x134, 0x136, 0x137, 0x138, 0x139, 0x13a, 0x13b, 0x13c, 0x13d, 0x13e,
    EV_DPAD.up, EV_DPAD.down, EV_DPAD.left, EV_DPAD.right
  ],
  abs: [EV_ABS.x, EV_ABS.y, EV_ABS.z, EV_ABS.rx, EV_ABS.ry, EV_ABS.rz]
}

/**
 * A Switch Pro controller on `hid-nintendo`.
 *
 * The layout is unremarkable — the driver maps it positionally, so the button
 * under your thumb is `BTN_SOUTH` exactly as on every other pad. It is here
 * because the *labels* are not: that button is printed **B**, and this fixture
 * is what pins the launcher relabelling rather than remapping it.
 */
export const SWITCH_PRO: PadFixture = {
  name: 'Nintendo Switch Pro Controller',
  vendor: '057e',
  product: '2009',
  keys: [
    0x130, 0x131, 0x133, 0x134, 0x136, 0x137, 0x138, 0x139, 0x13a, 0x13b, 0x13c, 0x13d, 0x13e,
    EV_DPAD.up, EV_DPAD.down, EV_DPAD.left, EV_DPAD.right
  ],
  abs: [EV_ABS.x, EV_ABS.y, EV_ABS.rx, EV_ABS.ry]
}

/**
 * A HOTAS, which is not a gamepad and must not be read as one.
 *
 * `BTN_TRIGGER` is 0x120, so joydev gives it index 0 — the same index a pad
 * gives to A. Folded into the launcher's reading as an untranslated index, that
 * trigger presses **confirm**.
 */
export const FLIGHT_STICK: PadFixture = {
  name: 'Thrustmaster T.16000M',
  vendor: '044f',
  product: 'b10a',
  keys: [0x120, 0x121, 0x122, 0x123, 0x124, 0x125],
  abs: [EV_ABS.x, EV_ABS.y, EV_ABS.z, EV_ABS.rz]
}

/** The fixture as one `/dev/input/js*` node, the way main would describe it. */
export function profileOf(
  fixture: PadFixture,
  node = 'js0',
  transport: PadProfile['transport'] = 'usb'
): PadProfile {
  const layout = joydevLayout(fixture.keys, fixture.abs)
  return {
    node,
    name: fixture.name,
    vendor: fixture.vendor,
    product: fixture.product,
    transport,
    resolved: 'kernel',
    buttons: layout.buttons,
    axes: layout.axes
  }
}

/** Chromium's `Gamepad.id` for that fixture, in the Linux fetcher's format. */
export function padIdOf(fixture: PadFixture, standard = false): string {
  const mapped = standard ? 'STANDARD GAMEPAD ' : ''
  return `${fixture.name} (${mapped}Vendor: ${fixture.vendor} Product: ${fixture.product})`
}
