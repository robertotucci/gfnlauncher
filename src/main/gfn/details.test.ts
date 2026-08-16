import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  gamepadSupport,
  getDetails,
  mapDetails,
  mapDetailsIndex,
  resetDetails,
  saveDetails
} from './details'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/gfn-launcher-test' } }))
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined)
}))

const base = {
  title: 'Control Ultimate Edition',
  shortDescription: 'A supernatural third-person shooter.',
  images: {
    KEY_ART: 'key.jpg',
    SCREENSHOTS: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg', 'f.jpg', 'g.jpg', 'h.jpg']
  },
  variants: [
    {
      id: 100,
      appStore: 'STEAM',
      supportedControls: ['GAMEPAD', 'KEYBOARD', 'MOUSE'],
      subscriptions: ['XBOX_GAME_PASS'],
      gfn: { releaseDate: '2019-08-27T02:00:00.000000+0000' }
    }
  ]
}

beforeEach(() => {
  resetDetails()
  vi.mocked(readFile).mockReset()
})

describe('gamepadSupport', () => {
  it('reads full, partial and neither', () => {
    expect(gamepadSupport(['GAMEPAD', 'KEYBOARD'])).toBe('full')
    expect(gamepadSupport(['GAMEPAD_PARTIAL', 'MOUSE'])).toBe('partial')
    expect(gamepadSupport(['KEYBOARD', 'MOUSE'])).toBe('none')
    expect(gamepadSupport(null)).toBe('none')
  })
})

describe('mapDetails', () => {
  it('keys the record by the id the deep link uses', () => {
    // A disagreement with mapApp here is the one failure that would silently
    // show an empty panel for a title whose data is perfectly good.
    expect(mapDetails(base)?.cmsId).toBe('100')
  })

  it('agrees with mapApp on which variant to describe', () => {
    const details = mapDetails({
      ...base,
      variants: [
        { id: 1, appStore: 'EPIC', gfn: { releaseDate: '2019-01-01T00:00:00.000000+0000' } },
        { id: 2, appStore: 'STEAM', gfn: { releaseDate: '2020-01-01T00:00:00.000000+0000' } }
      ]
    })
    expect(details?.cmsId).toBe('2')
    expect(details?.releaseDate?.slice(0, 4)).toBe('2020')
  })

  it('caps the screenshot list', () => {
    // The feed offers about ten per title and their URLs dominate the detail
    // cache, so the walk takes a fixed number rather than whatever it is given.
    const shots = Array.from({ length: 14 }, (_, index) => `shot-${index}.jpg`)
    const details = mapDetails({ ...base, images: { ...base.images, SCREENSHOTS: shots } })
    expect(details?.screenshots).toHaveLength(10)
    expect(details?.screenshots.at(-1)).toBe('shot-9.jpg')
  })

  it('takes every shot from a title that has fewer than the cap', () => {
    expect(mapDetails(base)?.screenshots).toHaveLength(8)
  })

  it('turns wire codes into labels people read', () => {
    const details = mapDetails(base)
    expect(details?.controls).toEqual(['Gamepad', 'Keyboard', 'Mouse'])
    expect(details?.subscriptions).toEqual(['Xbox Game Pass'])
  })

  it('passes an unknown code through rather than dropping it', () => {
    const details = mapDetails({
      ...base,
      variants: [{ id: 100, appStore: 'STEAM', supportedControls: ['EYE_TRACKER'] }]
    })
    expect(details?.controls).toEqual(['eye tracker'])
  })

  it('returns null for a feed that carries no detail fields at all', () => {
    // The authenticated catalog answers this shape; an empty husk would make
    // the panel draw a frame around nothing.
    expect(mapDetails({ title: 'X', variants: [{ id: 5, appStore: 'STEAM' }] })).toBeNull()
  })

  it('keeps a title that has screenshots but no description', () => {
    const details = mapDetails({ ...base, shortDescription: '  ' })
    expect(details?.description).toBeNull()
    expect(details?.screenshots.length).toBeGreaterThan(0)
  })

  it('drops what the grid drops', () => {
    expect(mapDetails({ ...base, type: 'DLC' })).toBeNull()
  })

  it('indexes a walk by cmsId, skipping what it cannot describe', () => {
    const index = mapDetailsIndex([base, { title: 'No variants', variants: [] }])
    expect(Object.keys(index)).toEqual(['100'])
  })

  it('indexes every variant, not just the launchable one', () => {
    // Signed in, a tile carries the id of the edition the user owns, while this
    // index is built from the public feed, which settles on Steam. Keying only
    // one of them would leave multi-store titles with an empty panel.
    const index = mapDetailsIndex([
      {
        ...base,
        variants: [
          { id: 11, appStore: 'EPIC', supportedControls: ['GAMEPAD_PARTIAL'] },
          { id: 22, appStore: 'STEAM', supportedControls: ['GAMEPAD'] }
        ]
      }
    ])

    expect(Object.keys(index).sort()).toEqual(['11', '22'])
    // And each record describes its own edition, not the other one's.
    expect(index['11']?.gamepad).toBe('partial')
    expect(index['22']?.gamepad).toBe('full')
  })
})

describe('the details cache', () => {
  it('serves from memory after a refresh, without touching the disk', async () => {
    await saveDetails({ '100': mapDetails(base)! })
    expect(await getDetails('100')).not.toBeNull()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('reads the file once on a cold start, however many callers arrive', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ '100': mapDetails(base) }))

    const [first, second] = await Promise.all([getDetails('100'), getDetails('100')])

    expect(first?.cmsId).toBe('100')
    expect(second?.cmsId).toBe('100')
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('reports an unknown title as absent rather than throwing', async () => {
    vi.mocked(readFile).mockResolvedValue('{}')
    expect(await getDetails('nope')).toBeNull()
  })

  it('survives a missing or truncated cache file', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'))
    expect(await getDetails('100')).toBeNull()
  })
})
