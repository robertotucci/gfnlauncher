import { type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { LaunchResult } from '@shared/types'

/** What a failed launch has to say for itself. */
export interface LaunchNoticeState {
  /** Plain-language reason, already resolved from the result. */
  reason: string
  /** The argv or URL that failed, so the fault is diagnosable without a shell. */
  command: string | null
}

/**
 * Turns a failed `LaunchResult` into something readable at three metres.
 *
 * Pure and exported so the wording is unit-tested rather than eyeballed. The
 * raw `error` is a spawn message — "spawn flatpak ENOENT" names the fault
 * precisely and explains nothing — so the known ones get a sentence and
 * everything else falls back to the original text, which still beats silence.
 */
export function launchFailureReason(result: LaunchResult): string {
  const error = result.error ?? ''

  if (error === 'Malformed launch request') {
    return 'This title has no launchable id.'
  }

  if (error.includes('ENOENT')) {
    return 'Flatpak is not installed, or not on PATH.'
  }

  if (result.mode === 'web') {
    return 'The GeForce NOW web client would not open.'
  }

  return error || 'GeForce NOW did not start.'
}

/**
 * A launch that failed, said out loud.
 *
 * The launcher's whole failure model is that a control which silently does
 * nothing is the one fault nobody on a sofa can diagnose — the power dialog
 * surfaces a polkit refusal for exactly this reason. Launching had no such
 * surface: it logged to a console no TV has.
 *
 * Three constraints shape it, all from the design rules:
 *
 * - **Bottom-anchored**, in the same strip as `LoadingBar` and `StatusFooter`,
 *   because above that strip the screen belongs to cover art.
 * - **Colourless.** The `--status-*` hues are confined to the server-status
 *   screen and the accent belongs to focus, so a fault is distinguished by
 *   weight and an icon instead — which is what the design rules prescribe when
 *   a state needs telling apart.
 * - **Not focusable.** Nothing here is a control, so it stays out of
 *   `SpatialFocus` entirely: no scope to activate, nothing to hand focus back
 *   to, and the cursor never moves out from under the user.
 */
export function LaunchNotice({ notice }: { notice: LaunchNoticeState | null }): ReactNode {
  if (!notice) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-border/60 bg-card/95 flex shrink-0 items-center gap-3 border-t px-10 py-3"
    >
      <TriangleAlert className="text-foreground size-4 shrink-0" aria-hidden />
      <span className="text-foreground text-sm font-medium">{notice.reason}</span>
      {notice.command && (
        <span className="text-muted-foreground ml-auto truncate font-mono text-xs">
          {notice.command}
        </span>
      )}
    </div>
  )
}
