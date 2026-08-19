import { type ReactNode } from 'react'

/**
 * A section head: label, a rule that runs out to the margin, and a count.
 *
 * The rule is the only structural ornament on the two screens that use it, and
 * the count on the end is the reason it earns its place — "36 regions" and
 * "3 nearby" are facts about what follows, not decoration.
 *
 * It lives in its own file because the Status board and the Devices screen are
 * the same kind of page: a list of hardware somebody came here to check on,
 * with no cover art to compete with. A second copy would have drifted.
 */
export function SectionRule({
  label,
  count
}: {
  label: string
  count?: ReactNode
}): ReactNode {
  return (
    <div className="flex items-center gap-4 px-4">
      <span className="text-muted-foreground shrink-0 text-xs font-medium tracking-widest uppercase">
        {label}
      </span>
      <span className="border-border/60 min-w-0 flex-1 border-t" />
      {count !== undefined && (
        <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
          {count}
        </span>
      )}
    </div>
  )
}
