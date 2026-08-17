import { describe, expect, it } from 'vitest'
import { scanFlatpakProgress } from './flatpakProgress'

/**
 * Captured verbatim from `flatpak --user install -y flathub app.curocalc.calculator`
 * with stdout piped, on flatpak 1.18.1 and an Italian host — which is why the
 * size reads `19,4 MB`. That comma is the reason this parser reads nothing but
 * the digits before a `%`.
 */
const REAL_OUTPUT = [
  'Looking for matches…',
  '',
  ' 1.\t   \tapp.curocalc.calculator\tstable\ti\tflathub\t< 19,4 MB',
  '',
  'Installing…',
  'Installing…                        0%  0 bytes/s',
  'Installing… ██████████████▊       74%',
  'Installing… ████████████████████ 100%',
  'Installation complete.',
  ''
].join('\n')

describe('scanFlatpakProgress', () => {
  it('reads the last percentage in a chunk', () => {
    // Several progress lines can arrive in one read, and only the newest is
    // worth showing.
    expect(scanFlatpakProgress(REAL_OUTPUT).percent).toBe(100)
  })

  it('reads an intermediate percentage', () => {
    expect(scanFlatpakProgress('Installing… ██████████████▊       74%\n').percent).toBe(74)
  })

  it('reads zero rather than reporting nothing', () => {
    // `0%` is a real state and the bar has to start there, so it must not be
    // confused with "no progress in this chunk".
    expect(scanFlatpakProgress('Installing…                        0%  0 bytes/s\n').percent).toBe(0)
  })

  it('ignores the locale-formatted size in the ref listing', () => {
    // `19,4 MB` is `g_format_size` output in the host session's language. It is
    // also the one line here carrying text from a remote.
    const listing = ' 1.\t   \tapp.curocalc.calculator\tstable\ti\tflathub\t< 19,4 MB\n'
    expect(scanFlatpakProgress(listing).percent).toBeNull()
  })

  it('ignores the translatable words entirely', () => {
    // Which is what makes it indifferent to install vs update vs uninstall, and
    // to a release that renames any of them.
    expect(scanFlatpakProgress('Aggiornamento… ████ 42%\n').percent).toBe(42)
    expect(scanFlatpakProgress('Updating… ████ 42%\n').percent).toBe(42)
  })

  it('holds back a partial line instead of parsing half a number', () => {
    // The bug this pins: a pipe splitting inside "74%" would otherwise report
    // 4% and the bar would jump backwards.
    const first = scanFlatpakProgress('Installing… ███ 7')
    expect(first.percent).toBeNull()
    expect(first.remainder).toBe('Installing… ███ 7')

    const second = scanFlatpakProgress(`${first.remainder}4%\n`)
    expect(second.percent).toBe(74)
    expect(second.remainder).toBe('')
  })

  it('keeps the tail of a chunk that ends mid-line', () => {
    const scan = scanFlatpakProgress('Installing… 12%\nInstalling… 3')
    expect(scan.percent).toBe(12)
    expect(scan.remainder).toBe('Installing… 3')
  })

  it('rejects a value above 100', () => {
    expect(scanFlatpakProgress('something 400% odd\n').percent).toBeNull()
  })

  it('does not match a percentage glued to more text', () => {
    expect(scanFlatpakProgress('build 50%complete\n').percent).toBeNull()
  })

  it('is null for output with no progress in it', () => {
    // What `--noninteractive` produces, and what the first seconds of any run
    // look like.
    expect(scanFlatpakProgress('Looking for matches…\n').percent).toBeNull()
    expect(scanFlatpakProgress('').percent).toBeNull()
  })
})
