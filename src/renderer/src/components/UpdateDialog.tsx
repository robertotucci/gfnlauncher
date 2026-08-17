import { type ComponentType, type ReactNode } from 'react'
import { ArrowRight, Download, RotateCw, TriangleAlert, X } from 'lucide-react'
import type { UpdateApplyResult, UpdateProgress, UpdateStatus } from '@shared/types'
import { LATEST_RELEASE_PAGE_URL } from '@shared/update'
import { useFocusable } from '@/focus/SpatialFocus'
import { StoreQr } from '@/components/StoreQr'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

export const UPDATE_SCOPE = 'update'

/**
 * Where the cursor lands when the notice opens.
 *
 * The install row when there is one, because that is what the notice is *for*
 * — the same reasoning that lands the details panel on Play and the power
 * dialog on Sleep. When the launcher cannot install its own update, there is
 * only one focusable left and this is not a preference: a chain that falls
 * through to an unmounted id parks focus as pending and gags the focus
 * manager's own recovery, exactly as `DONATE_FOCUS_ID` exists to avoid.
 */
export function updateLandingId(status: UpdateStatus): string {
  return status.canApply ? 'update:apply' : 'update:close'
}

/** "128 MB". Whole megabytes: nobody on a sofa is reading a third decimal. */
function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`
}

/**
 * What the launcher calls this install form, out loud.
 *
 * Named after what the user installed rather than after the code path, so the
 * line reads as recognition — "yes, this is my Flatpak" — rather than as an
 * internal label leaking out.
 */
const CHANNEL_LABEL: Record<UpdateStatus['channel'], string> = {
  flatpak: 'Flatpak',
  appimage: 'AppImage',
  system: 'System package',
  unknown: 'Development build'
}

function Choice({
  id,
  label,
  description,
  Icon,
  disabled,
  onRun
}: {
  id: string
  label: string
  description: string
  Icon: ComponentType<{ className?: string }>
  disabled: boolean
  onRun: () => void
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(id, {
    scope: UPDATE_SCOPE,
    onConfirm: () => {
      if (!disabled) onRun()
    }
  })

  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onRun}
      className={cn(
        'border-border flex w-full items-center gap-4 rounded-md border px-4 py-3 text-left transition-colors duration-150 disabled:opacity-50',
        focused ? 'focus-ring bg-accent' : 'bg-card'
      )}
    >
      <Icon className="text-muted-foreground size-5 shrink-0" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="text-muted-foreground mt-0.5 block text-xs">{description}</span>
      </span>
    </button>
  )
}

/**
 * A new version of the launcher, said out loud.
 *
 * ── Why this is a dialog and looks like the power one ───────────────────────
 *
 * A real shadcn `Dialog` with everything Radix does about focus turned off, for
 * exactly the reasons `PowerDialog` documents: focus here is virtual, so an
 * autofocus would move the browser's cursor somewhere the gamepad's is not, and
 * Escape is left to the `back` intent so that B and Escape close this through
 * one path. Copying that arrangement rather than inventing a second one is the
 * point — this is the launcher's second modal, and two modal idioms is one more
 * than a ten-foot interface can teach.
 *
 * ── What it says, and in what order ─────────────────────────────────────────
 *
 * The version transition is the subject, not a footnote: `0.1.0 → 0.2.0` in
 * mono is the one fact the notice exists to deliver, and a number is more
 * legible at three metres than a sentence about a number. Under it, the
 * release's own headlines — `summariseNotes` takes the bold lead of each
 * changelog bullet, which is already the short version somebody wrote by hand.
 *
 * Colourless, like everything outside the status screen. The accent appears
 * twice and only twice: on the focus ring, and on the download bar, where it
 * already means "the launcher is working" because that is what `LoadingBar`
 * uses it for.
 *
 * ── The code, when the launcher cannot install for you ──────────────────────
 *
 * A `.deb` belongs to a package manager and root is not on the table here, so
 * that path has no button. It gets the QR instead — the launcher's existing
 * answer to "this link has to leave the television", already used for store
 * pages and the donation page. The alternative was a URL nobody can type into
 * a device that has no keyboard.
 */
export function UpdateDialog({
  status,
  progress,
  applying,
  result,
  restartIn,
  restartRefused,
  closing,
  onApply,
  onRestart,
  onDismiss,
  onClose
}: {
  status: UpdateStatus
  /** How far the install has got. Null before the first report arrives. */
  progress: UpdateProgress | null
  applying: boolean
  /** The last attempt, or null before one has been made. */
  result: UpdateApplyResult | null
  /**
   * Seconds until the launcher restarts by itself, 0 once it has started, or
   * null when nothing is counting — either because this build cannot restart
   * itself or because the user stopped it.
   */
  restartIn: number | null
  /**
   * The restart was asked for and main refused it.
   *
   * Not a failed install — the new version is on disk — so it does not go
   * through `result`. It is the one outcome on this path that would otherwise
   * be indistinguishable from a slow quit: the row reads "Restarting…" and
   * nothing ever happens.
   */
  restartRefused: boolean
  /** True while the exit animation plays; the parent unmounts after EXIT_MS. */
  closing: boolean
  onApply: () => void
  onRestart: () => void
  /** Records this version as seen, so the notice does not open itself again. */
  onDismiss: () => void
  onClose: () => void
}): ReactNode {
  const installed = result?.ok === true
  const failed = result !== null && !result.ok

  return (
    <Dialog open={!closing} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        className="gap-5 duration-150 sm:max-w-lg"
      >
        <DialogHeader className="gap-1">
          <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
            {installed ? 'Installed' : 'Update'}
          </p>
          <DialogTitle className="text-xl tracking-tight">
            GFN Launcher {status.latestVersion}
          </DialogTitle>
          {/* The subject of the whole dialog, and the reason it is mono and not
              prose: at three metres two numbers and an arrow are read in one
              glance, where "version 0.2.0 replaces version 0.1.0" is not.
              An icon rather than the → character — a face font missing a glyph
              is what turned the footer legend into tofu once already. */}
          <DialogDescription asChild>
            <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-sm tabular-nums">
              <span>{status.currentVersion}</span>
              <ArrowRight className="size-3.5" aria-hidden />
              <span className="text-foreground">{status.latestVersion}</span>
              <span aria-hidden>·</span>
              <span>{CHANNEL_LABEL[status.channel]}</span>
              {status.downloadBytes !== null && (
                <>
                  <span aria-hidden>·</span>
                  <span>{megabytes(status.downloadBytes)}</span>
                </>
              )}
            </p>
          </DialogDescription>
        </DialogHeader>

        {/* The release's own headlines. Hidden once something has been
            installed: at that point the news is the outcome, not the notes. */}
        {!installed && status.notes.length > 0 && (
          <ul className="flex flex-col gap-2">
            {status.notes.map((note) => (
              <li key={note} className="flex gap-3 text-sm leading-snug">
                {/* A drawn dot rather than a bullet character, for the same
                    reason the arrow above is an icon. */}
                <span
                  className="bg-muted-foreground/50 mt-[0.5em] size-1 shrink-0 rounded-full"
                  aria-hidden
                />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        )}

        {applying ? (
          <Progress progress={progress} channel={status.channel} />
        ) : (
          <div className="flex flex-col gap-2">
            {installed ? (
              <>
                <p className="text-sm">
                  {result?.canRestart
                    ? 'The new version is on disk and the launcher has to reopen to run it.'
                    : 'The new version is on disk. It starts the next time you open the launcher.'}
                </p>
                {result?.canRestart && (
                  <Choice
                    id="update:restart"
                    label={restartIn === 0 ? 'Restarting…' : 'Restart now'}
                    description={
                      restartRefused
                        ? // The install worked and only the reopening did not,
                          // so this says what is left to do rather than reading
                          // as a failed update.
                          'The launcher could not restart itself. Close it and open it again to ' +
                          'run the new version.'
                        : restartIn === null
                          ? 'Closes the launcher and opens it again on the new version.'
                          : restartIn === 0
                            ? 'Closing the launcher. It comes back on its own.'
                            : // Counted out loud rather than done silently:
                              // this is the launcher taking the screen away
                              // from somebody who may have walked off, and a
                              // number ticking down is the only warning a
                              // television can give.
                              `Restarting on its own in ${restartIn} second${restartIn === 1 ? '' : 's'}.`
                    }
                    Icon={restartRefused ? TriangleAlert : RotateCw}
                    disabled={restartIn === 0}
                    onRun={onRestart}
                  />
                )}
                <Choice
                  id="update:close"
                  label={result?.canRestart ? (restartIn === null ? 'Later' : 'Not yet') : 'Close'}
                  description={
                    result?.canRestart
                      ? 'Stops the countdown. The new version waits until you reopen the launcher.'
                      : 'Back to the library.'
                  }
                  Icon={X}
                  disabled={restartIn === 0}
                  onRun={onClose}
                />
              </>
            ) : status.canApply ? (
              <>
                <Choice
                  id="update:apply"
                  label={failed ? 'Try again' : 'Install the update'}
                  description={
                    status.channel === 'flatpak'
                      ? 'Runs flatpak update on this machine. The new version starts the next time you open the launcher.'
                      : `Downloads ${status.downloadBytes ? megabytes(status.downloadBytes) : 'the new AppImage'}, checks it against the published checksum, and replaces this one.`
                  }
                  Icon={Download}
                  disabled={false}
                  onRun={onApply}
                />
                <Choice
                  id="update:close"
                  label="Not now"
                  description="Hides this notice until the next release. Settings can bring it back."
                  Icon={X}
                  disabled={false}
                  onRun={onDismiss}
                />
              </>
            ) : (
              <>
                {/* No button, because there is nothing here this launcher is
                    allowed to do. The code is the answer instead — the same
                    one the details panel and the Support screen give when a
                    link has to reach a device that can follow it. */}
                <div className="flex items-start gap-5 py-1">
                  {/* Larger than the details panel's, because here the code is
                      the action and not a footnote: nothing else on this branch
                      can move the release onto a device that can install it. */}
                  <StoreQr
                    url={LATEST_RELEASE_PAGE_URL}
                    label="github.com/releases"
                    size="size-[10rem]"
                  />
                  <p className="text-muted-foreground text-sm leading-snug">
                    {status.blockedReason}
                  </p>
                </div>
                <Separator className="my-1" />
                <Choice
                  id="update:close"
                  label="Not now"
                  description="Hides this notice until the next release. Settings can bring it back."
                  Icon={X}
                  disabled={false}
                  onRun={onDismiss}
                />
              </>
            )}
          </div>
        )}

        {/* A refusal has to be readable, and it has to name the command: this
            is the same contract the power dialog keeps with polkit. */}
        {failed && !applying && (
          <div className="flex items-start gap-3">
            <TriangleAlert className="text-foreground mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm">{result?.error}</p>
              {result?.command && (
                <p className="text-muted-foreground mt-1 truncate font-mono text-xs">
                  {result.command}
                </p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * How far the install has got.
 *
 * Determinate where it can be, and the byte counts are spelled out beside the
 * bar rather than being left to it. A bar alone answers "is it moving"; on a
 * 130 MB transfer over a home connection the question is "how much longer", and
 * only a number answers that. `tabular-nums` so the figures do not jitter as
 * they climb.
 *
 * Indeterminate is not a fallback for "no data yet" — it is the honest state of
 * the Flatpak path, where the download belongs to `flatpak` and this process
 * has nothing to count. It borrows `animate-sweep` from `LoadingBar`, which is
 * the launcher's existing way of saying "working, no idea how long", so the two
 * do not have to be learned separately.
 *
 * The fill is `bg-primary` for the same reason: that is already what
 * `LoadingBar` means by it. A second colour would be a second vocabulary.
 */
function Progress({
  progress,
  channel
}: {
  progress: UpdateProgress | null
  channel: UpdateStatus['channel']
}): ReactNode {
  const total = progress?.totalBytes ?? 0
  const received = progress?.receivedBytes ?? 0
  // Percent rather than bytes, because only one of the two paths counts bytes:
  // flatpak prints a percentage and never says how many. Bytes are the extra
  // detail beside the bar when they exist, not the thing driving it.
  const percent = progress?.percent ?? null
  const determinate = percent !== null
  const phase =
    progress?.phase === 'verifying'
      ? 'Checking the download'
      : progress?.phase === 'installing'
        ? 'Putting it in place'
        : progress?.phase === 'downloading'
          ? 'Downloading'
          : channel === 'flatpak'
            ? 'Asking Flatpak to update'
            : 'Starting the download'

  return (
    <div className="flex flex-col gap-2 py-1" role="status" aria-live="polite">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium">{phase}</span>
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {/* Megabytes when the path counts them, the bare percentage when it
              does not. Never both — two numbers saying the same thing is one
              more than anyone reads from a sofa. */}
          {total > 0
            ? `${megabytes(received)} of ${megabytes(total)}`
            : percent !== null
              ? `${percent}%`
              : ''}
        </span>
      </div>

      <div className="bg-muted relative h-[3px] w-full overflow-hidden rounded-full">
        {determinate ? (
          <div
            className="bg-primary h-full transition-[width] duration-200 ease-linear"
            // The one inline style in the dialog, and it has to be: a width
            // that changes several times a second is data, not a class.
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="animate-sweep bg-primary absolute inset-y-0 left-0 w-[22%]" />
        )}
      </div>

      <p className="text-muted-foreground text-xs">
        {channel === 'flatpak'
          ? 'Leave the launcher open. Nothing changes on disk until Flatpak has the whole update.'
          : 'Leave the launcher open. Nothing is replaced until the checksum matches.'}
      </p>
    </div>
  )
}
