import { useMemo, type ReactNode } from 'react'
import { qrPath } from '@/lib/qr'
import { cn } from '@/lib/utils'

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
export function StoreQr({
  url,
  label,
  size
}: {
  url: string
  label: string
  /**
   * Tailwind size class, when the default is the wrong one.
   *
   * 7rem is right in the details panel, where the code is one fact among many
   * and the game is the subject. It is wrong wherever the code *is* the answer
   * — a phone has to lock onto it from a sofa — which is why the Support screen
   * draws its own at cover-art scale, and why the update notice asks for
   * something in between.
   */
  size?: string
}): ReactNode {
  const path = useMemo(() => qrPath(url), [url])

  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5">
      {/* The dark modules take `currentColor` rather than a literal, so even
          the inside of a QR stays on the palette. The quiet zone comes from the
          viewBox padding: without it a scanner will not lock on. */}
      <svg
        viewBox={`-2 -2 ${path.count + 4} ${path.count + 4}`}
        className={cn('text-background rounded-sm bg-white/90 p-1', size ?? 'size-[7rem]')}
        aria-hidden="true"
        shapeRendering="crispEdges"
      >
        <path d={path.d} fill="currentColor" />
      </svg>
      <p className="text-muted-foreground/70 font-mono text-[0.6rem]">{label}</p>
    </div>
  )
}
