import { type ComponentType, type ReactNode } from 'react'
import {
  Gamepad2,
  Headphones,
  Keyboard,
  Laptop,
  Monitor,
  Mouse,
  MousePointer2,
  MousePointerBan,
  Smartphone,
  Speaker,
  Usb
} from 'lucide-react'
import type { Notice, NoticeIcon } from '@shared/notify'
import { cn } from '@/lib/utils'

/**
 * Which glyph each notice wears.
 *
 * The mapping is here rather than in `@shared/notify` because that module has
 * to compile into the main process too and must stay free of DOM types — so it
 * carries an id and this carries the component, the same split `glyphs.tsx`
 * makes for pad buttons.
 *
 * It is also doing the work a colour would do elsewhere. The shell is
 * colourless by design: the accent belongs to focus and `--status-*` belongs to
 * the server-status screen, so a state that needs telling apart is told apart
 * by an icon and by weight. `LaunchNotice` distinguishes a failed launch with a
 * `TriangleAlert` for exactly this reason.
 *
 * **A device wears the same glyph coming and going**, and the title carries the
 * direction. Two reasons. The glyph's job on those cards is *which kind of
 * thing*, which does not change when a headset switches off — and Lucide has an
 * "off" variant for some of these and not others, so half the pairs would have
 * had to fall back to a generic one and the set would say something different
 * depending on what you unplugged. The pointer pair is the exception because
 * there is no name on those cards to read: there the glyph **is** the state.
 *
 * The names deliberately match `DevicesScreen`'s, which draws the same hardware
 * on the Bluetooth list — a headset should not be two different pictures in one
 * launcher.
 */
const NOTICE_ICONS: Record<NoticeIcon, ComponentType<{ className?: string }>> = {
  pointer: MousePointer2,
  'pointer-off': MousePointerBan,
  gamepad: Gamepad2,
  keyboard: Keyboard,
  mouse: Mouse,
  headphones: Headphones,
  speaker: Speaker,
  display: Monitor,
  computer: Laptop,
  phone: Smartphone,
  // Whatever BlueZ would not name — most Low Energy hardware on first sight.
  // A plug rather than a question mark: the card is about something arriving,
  // and "we do not know what this is" is not the part worth drawing.
  device: Usb
}

/**
 * What the launcher has to say for itself, top right.
 *
 * ── Presentational, and deliberately so ─────────────────────────────────────
 *
 * There is no timer here, no queue and no state. Main owns all three and pushes
 * the rendered list — see `@shared/notify` — because the same stack has to move
 * between this window and the overlay that draws over a running game, and a
 * component holding its own clock cannot be handed a notice halfway through its
 * life. `leaving` arrives as data for the same reason: the exit animation plays
 * in a window main is about to hide, so the two have to agree on how long it
 * takes.
 *
 * ── The three rules it inherits from `LaunchNotice` ─────────────────────────
 *
 * - **Colourless.** An icon and `text-foreground` weight, never a hue.
 * - **Not focusable.** Nothing on it is a control, so it stays out of
 *   `SpatialFocus` entirely: no scope to activate, nothing to hand focus back
 *   to, and the cursor never moves out from under the user. That is also why it
 *   auto-dismisses rather than carrying a dismiss button.
 * - **`pointer-events-none`.** With the desktop cursor up, a card floating over
 *   the grid would be one more thing an injected click can land on — and above
 *   a stream, one that would swallow the click meant for the game underneath.
 *
 * ── Where it sits ───────────────────────────────────────────────────────────
 *
 * Top right, which is the one place in this interface that is not spoken for:
 * cover art starts at the first pixel and every piece of launcher state lives
 * in the bottom strip. It is `fixed`, so the same component lays out
 * identically in the launcher's window and in an overlay sized to the card.
 * `z-60` clears everything that exists — search is `z-20`, the details panel
 * `z-30`, the screenshot viewer `z-40` and shadcn's `Dialog` `z-50`.
 */
export function NoticeStack({ notices }: { notices: readonly Notice[] }): ReactNode {
  if (notices.length === 0) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed top-6 right-6 z-60 flex w-[26rem] max-w-[calc(100vw-3rem)] flex-col gap-3"
    >
      {notices.map((notice) => {
        const Icon = NOTICE_ICONS[notice.icon]

        return (
          <div
            key={notice.id}
            className={cn(
              'border-border/60 bg-card/95 flex items-start gap-3 rounded-md border px-4 py-3 backdrop-blur-sm',
              // `fill-mode-forwards` on the way out so the card holds its
              // last frame rather than snapping back into view for the few
              // milliseconds before main removes it.
              notice.leaving
                ? 'animate-out slide-out-to-right-6 fade-out fill-mode-forwards duration-150'
                : 'animate-in slide-in-from-right-6 fade-in duration-200'
            )}
          >
            <Icon className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden />
            <span className="min-w-0">
              <span className="text-foreground block text-sm font-medium">{notice.title}</span>
              {notice.hint && (
                <span className="text-muted-foreground mt-0.5 block text-xs">{notice.hint}</span>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}
