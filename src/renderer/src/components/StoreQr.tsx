import { useMemo, type ReactNode } from 'react'
import qrcode from 'qrcode-generator'

/**
 * A store page as something a person on a sofa can actually reach.
 *
 * The catalog carries a Steam or Epic URL per edition, and on this machine that
 * is nearly useless: the launcher is fullscreen on a TV with no pointer and no
 * browser worth opening. A code the user photographs moves the link to the one
 * device in the room that can follow it.
 *
 * Rendered as inline SVG rects from the module matrix rather than through a
 * canvas: no raster to scale, and the colours stay in the palette instead of
 * being baked into an image.
 */
export function StoreQr({ url, label }: { url: string; label: string }): ReactNode {
  const path = useMemo(() => {
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
  }, [url])

  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5">
      {/* The dark modules take `currentColor` rather than a literal, so even
          the inside of a QR stays on the palette. The quiet zone comes from the
          viewBox padding: without it a scanner will not lock on. */}
      <svg
        viewBox={`-2 -2 ${path.count + 4} ${path.count + 4}`}
        className="text-background size-[7rem] rounded-sm bg-white/90 p-1"
        aria-hidden="true"
        shapeRendering="crispEdges"
      >
        <path d={path.d} fill="currentColor" />
      </svg>
      <p className="text-muted-foreground/70 font-mono text-[0.6rem]">{label}</p>
    </div>
  )
}
