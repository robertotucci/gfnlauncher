import qrcode from 'qrcode-generator'

/** A QR code as an SVG path, plus the grid it was drawn on. */
export interface QrPath {
  /** One `M…h1v1h-1z` subpath per dark module, in module units. */
  d: string
  /** Modules per side. The viewBox needs it to size the quiet zone. */
  count: number
}

/**
 * Encodes a URL as a path in module coordinates.
 *
 * Kept out of the components because two of them draw the same matrix at
 * different sizes, and neither should own the encoder. Pure, so the one thing
 * that cannot be checked by eye — that every module lands inside the grid the
 * viewBox is built from — can be checked by a test.
 */
export function qrPath(url: string): QrPath {
  // Type 0 lets the encoder pick the smallest version that fits; L is the
  // lowest error correction, which keeps the module count — and so the
  // printed square — as coarse and as scannable across a room as possible.
  const qr = qrcode(0, 'L')
  qr.addData(url)
  qr.make()

  const count = qr.getModuleCount()
  let d = ''
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (qr.isDark(row, column)) d += `M${column} ${row}h1v1h-1z`
    }
  }
  return { d, count }
}
