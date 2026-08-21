import { describe, expect, it } from 'vitest'
import { GFN_WM_CLASS } from './flatpak'
import {
  buildFindArgv,
  buildFullscreenArgv,
  buildKwinScript,
  buildWindowNameArgv,
  fullscreenBackends,
  pageHasLoaded
} from './present'

// Argv and script text only, never execution: a test that ran either of these
// would reshape a window on the machine running the suite.
describe('the xdotool argvs', () => {
  it('finds only the mapped window', () => {
    expect(buildFindArgv()).toEqual(['search', '--onlyvisible', '--class', 'GeForceNOW'])
  })

  it('keeps --onlyvisible, which is what makes the sweep terminable', () => {
    // The client owns four X11 windows of this class and three are unmapped
    // helpers that exist from the first second. Without the flag the search
    // matches those and exits 0 before there is anything to fullscreen, so the
    // sweep would stop on a false success and the real window would keep its
    // title bar.
    expect(buildFindArgv()).toContain('--onlyvisible')
  })

  it('reads the title through getwindowname rather than a --name filter', () => {
    // Measured: `search --all --class GeForceNOW --name 'GeForce NOW'` matches
    // nothing even once the title is set, because SDL writes `_NET_WM_NAME` and
    // `--name` reads the legacy `WM_NAME`. This call sees it.
    expect(buildWindowNameArgv('18874372')).toEqual(['getwindowname', '18874372'])
    expect(buildFindArgv()).not.toContain('--name')
  })

  it('fullscreens one window by id rather than chaining onto a search', () => {
    // The chained `search … windowstate` form fires the instant the window is
    // mapped, which is exactly too early — the title has to be read in between.
    expect(buildFullscreenArgv('18874372')).toEqual([
      'windowstate',
      '--add',
      'FULLSCREEN',
      '18874372'
    ])
  })

  it('names the class the client actually has', () => {
    expect(buildFindArgv()).toContain(GFN_WM_CLASS)
  })

  it('passes every word as its own argument rather than a shell string', () => {
    // execFile with an argv array, so nothing here is ever parsed by a shell.
    for (const argument of [...buildFindArgv(), ...buildFullscreenArgv('1')]) {
      expect(argument).not.toContain(' ')
    }
  })
})

describe('pageHasLoaded', () => {
  it('is false while the window has no title', () => {
    // The window is added with an empty caption and the page sets it once it has
    // a document. Resizing before that corrupts the client's layout for the
    // whole session — the black-bars regression.
    expect(pageHasLoaded('')).toBe(false)
    expect(pageHasLoaded('   \n')).toBe(false)
  })

  it('is true once the page has titled itself', () => {
    expect(pageHasLoaded('GeForce NOW')).toBe(true)
    expect(pageHasLoaded('Alan Wake 2 su GeForce NOW')).toBe(true)
  })
})

describe('buildKwinScript', () => {
  const script = buildKwinScript()

  it('matches the class lowercased, which is how KWin reports it', () => {
    // xprop says `GeForceNOW`; KWin's `resourceClass` says `geforcenow`. A
    // script that matched the former would never fire.
    expect(script).toContain('"geforcenow"')
    expect(script).not.toContain('"GeForceNOW"')
  })

  it('sets both properties, because either alone leaves the desktop showing', () => {
    expect(script).toContain('noBorder = true')
    expect(script).toContain('fullScreen = true')
  })

  it('handles Plasma 5 and Plasma 6 spellings of the same two things', () => {
    expect(script).toContain('workspace.windowList')
    expect(script).toContain('workspace.clientList')
    expect(script).toContain('workspace.windowAdded')
    expect(script).toContain('workspace.clientAdded')
  })

  it('waits for captionChanged on a window it sees appear', () => {
    // The regression this guards: applying at windowAdded resized the window
    // before the page existed and left the client laid out for a 5762x3442
    // viewport, which pillarboxed every stream. Measured 114/111 px of bars.
    expect(script).toContain('captionChanged.connect')
    expect(script).toMatch(/added\.connect\(watch\)/)
  })

  it('applies at once to a window that is already there', () => {
    // That one has long since laid its page out, and waiting for a caption it
    // may never change again would hang rather than help.
    expect(script).toMatch(/for \(var i = 0; i < list\.length; i\+\+\) if \(mine\(list\[i\]\)\) apply\(list\[i\]\)/)
  })

  it('quotes the class rather than interpolating it raw', () => {
    // What comes out of here is executed by another process's script engine, so
    // the one thing that must not be possible is a class name closing the
    // string it is in.
    expect(buildKwinScript('a"; workspace.foo(); var b = "')).toContain(
      '"a\\"; workspace.foo(); var b = \\""'
    )
  })
})

describe('fullscreenBackends', () => {
  it('prefers KWin on KDE, where the permission is already granted', () => {
    expect(fullscreenBackends('kde')).toEqual(['kwin', 'xdotool'])
  })

  it('keeps xdotool behind KWin on KDE rather than instead of it', () => {
    // A session with `--talk-name=org.kde.KWin` revoked is still one where
    // xdotool would work, and degrading to it beats reporting a permission
    // problem the user did not know they had.
    expect(fullscreenBackends('kde')[1]).toBe('xdotool')
  })

  it('offers only xdotool everywhere else', () => {
    for (const desktop of ['gnome', 'xfce', 'sway', 'hyprland', 'unknown'] as const) {
      expect(fullscreenBackends(desktop)).toEqual(['xdotool'])
    }
  })
})
