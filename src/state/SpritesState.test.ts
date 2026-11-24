import { createStore } from 'jotai'
import { describe, expect, it } from 'vitest'

import { PASTE_POSITION_OFFSET } from '../constants'
import { SpriteData } from '../model/SpriteData'
import { SpriteMeta } from '../model/SpriteMeta'
import {
  addSpriteAction,
  allSpritesState,
  copiedSpritesState,
  copySpritesAction,
  deleteSelectedSpritesAction,
  deleteSpritesAction,
  pasteSpritesAction,
  selectedSpriteIdsState,
  selectedSpritesState,
  spriteDatasWithId,
  spriteIdsState,
  spriteMetasWithId,
} from './SpritesState'

const spriteData = (id: string): SpriteData => ({ ...SpriteData.default(), id, relativePath: id })
const spriteMeta = (id: string): SpriteMeta => ({ ...SpriteMeta.default(), id, name: id })
const sprites = (...ids: string[]): Sprites => ({
  datas: ids.map(spriteData),
  metas: ids.map(spriteMeta),
})

const placeAt = (spritesToPlace: Sprites, x: number, y: number): Sprites => ({
  datas: spritesToPlace.datas.map((data) => ({
    ...data,
    position: { ...data.position, x, y },
  })),
  metas: spritesToPlace.metas.map((meta) => ({ ...meta })),
})

describe('spriteDatasWithId and spriteMetasWithId', () => {
  it('default to an empty sprite for an unknown id', () => {
    const store = createStore()

    expect(store.get(spriteDatasWithId('unknown'))).toEqual(SpriteData.default())
    expect(store.get(spriteMetasWithId('unknown'))).toEqual(SpriteMeta.default())
  })

  it('return the same atom for the same id', () => {
    expect(spriteDatasWithId('a')).toBe(spriteDatasWithId('a'))
    expect(spriteMetasWithId('a')).toBe(spriteMetasWithId('a'))
  })
})

describe('allSpritesState', () => {
  it('is empty by default', () => {
    const store = createStore()

    expect(store.get(allSpritesState)).toEqual({ datas: [], metas: [] })
  })

  it('stores every sprite under its id and keeps their order', () => {
    const store = createStore()

    store.set(allSpritesState, sprites('a', 'b'))

    expect(store.get(spriteIdsState)).toEqual(['a', 'b'])
    expect(store.get(spriteDatasWithId('b'))).toEqual(spriteData('b'))
    expect(store.get(spriteMetasWithId('b'))).toEqual(spriteMeta('b'))
    expect(store.get(allSpritesState)).toEqual(sprites('a', 'b'))
  })

  it('accepts an updater derived from the current sprites', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a'))

    store.set(allSpritesState, (current) => ({
      datas: [...current.datas, spriteData('b')],
      metas: [...current.metas, spriteMeta('b')],
    }))

    expect(store.get(allSpritesState)).toEqual(sprites('a', 'b'))
  })

  it('replaces the previous sprites', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a', 'b'))

    store.set(allSpritesState, sprites('c'))

    expect(store.get(allSpritesState)).toEqual(sprites('c'))
  })
})

describe('selectedSpritesState', () => {
  it('holds only the selected sprites, in selection order', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a', 'b', 'c'))

    store.set(selectedSpriteIdsState, ['c', 'a'])

    expect(store.get(selectedSpritesState)).toEqual(sprites('c', 'a'))
  })
})

describe('addSpriteAction', () => {
  it('appends a sprite with its data and meta', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a'))

    store.set(addSpriteAction, 'b', spriteData('b'), spriteMeta('b'))

    expect(store.get(allSpritesState)).toEqual(sprites('a', 'b'))
  })
})

describe('deleteSpritesAction', () => {
  it('removes only the given sprites', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a', 'b', 'c'))

    store.set(deleteSpritesAction, ['a', 'c'])

    expect(store.get(allSpritesState)).toEqual(sprites('b'))
  })

  it('leaves the sprites unchanged for unknown ids', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a'))

    store.set(deleteSpritesAction, ['unknown'])

    expect(store.get(allSpritesState)).toEqual(sprites('a'))
  })

  it('removes the deleted ids from the selection and keeps the rest', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a', 'b', 'c'))
    store.set(selectedSpriteIdsState, ['a', 'b', 'c'])

    store.set(deleteSpritesAction, ['a', 'c'])

    expect(store.get(selectedSpriteIdsState)).toEqual(['b'])
    expect(store.get(selectedSpritesState)).toEqual(sprites('b'))
  })

  it('clears the selection entirely when every selected sprite is deleted', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a', 'b'))
    store.set(selectedSpriteIdsState, ['a', 'b'])

    store.set(deleteSpritesAction, ['a', 'b'])

    expect(store.get(selectedSpriteIdsState)).toEqual([])
  })
})

describe('deleteSelectedSpritesAction', () => {
  it('deletes the selected sprites and returns how many were removed', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a', 'b', 'c'))
    store.set(selectedSpriteIdsState, ['a', 'c'])

    const deletedCount = store.set(deleteSelectedSpritesAction)

    expect(deletedCount).toBe(2)
    expect(store.get(allSpritesState)).toEqual(sprites('b'))
    expect(store.get(selectedSpriteIdsState)).toEqual([])
  })

  it('does nothing and reports zero when nothing is selected', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a'))

    const deletedCount = store.set(deleteSelectedSpritesAction)

    expect(deletedCount).toBe(0)
    expect(store.get(allSpritesState)).toEqual(sprites('a'))
  })

  it('keeps the clipboard snapshot pasteable after the selected sprites are deleted', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a'))
    store.set(selectedSpriteIdsState, ['a'])
    store.set(copySpritesAction)

    store.set(deleteSelectedSpritesAction)

    expect(store.get(spriteIdsState)).toEqual([])
    expect(store.get(selectedSpriteIdsState)).toEqual([])
    expect(store.get(copiedSpritesState)).toEqual(sprites('a'))
    expect(store.set(pasteSpritesAction)).toHaveLength(1)
  })
})

describe('copySpritesAction', () => {
  it('copies nothing when there is no selection', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a'))

    const copiedCount = store.set(copySpritesAction)

    expect(copiedCount).toBe(0)
    expect(store.get(copiedSpritesState)).toEqual({ datas: [], metas: [] })
  })

  it('stores a snapshot of the selected data and runtime meta', () => {
    const store = createStore()
    const selection = placeAt(sprites('a', 'b'), 10, 20)
    store.set(allSpritesState, selection)
    store.set(selectedSpriteIdsState, ['a', 'b'])

    const copiedCount = store.set(copySpritesAction)

    expect(copiedCount).toBe(2)
    expect(store.get(copiedSpritesState)).toEqual(placeAt(sprites('a', 'b'), 10, 20))
  })

  it('stores an independent snapshot that does not mutate when the source sprite changes', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a'))
    store.set(selectedSpriteIdsState, ['a'])
    store.set(copySpritesAction)

    // Mutate the live source after copying
    store.set(spriteDatasWithId('a'), (data) => ({
      ...data,
      position: { x: 999, y: 999, z: 0 },
      opacity: 0.25,
    }))
    store.set(spriteMetasWithId('a'), (meta) => ({ ...meta, name: 'changed' }))

    const clipboard = store.get(copiedSpritesState)
    expect(clipboard.datas[0].position).toEqual({ x: 0, y: 0, z: 0 })
    expect(clipboard.datas[0].opacity).toBe(1)
    expect(clipboard.metas[0].name).toBe('a')
  })

  it('keeps a pasteable snapshot after the source sprites are deleted', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a', 'b'))
    store.set(selectedSpriteIdsState, ['a', 'b'])
    store.set(copySpritesAction)

    store.set(deleteSpritesAction, ['a', 'b'])

    // The clipboard is unaffected by the deletion
    expect(store.get(copiedSpritesState)).toEqual(sprites('a', 'b'))
    expect(store.get(spriteIdsState)).toEqual([])
    expect(store.get(selectedSpriteIdsState)).toEqual([])

    // And the snapshot can still be pasted
    const newIds = store.set(pasteSpritesAction)
    expect(newIds).toHaveLength(2)
    expect(store.get(spriteIdsState)).toHaveLength(2)
  })
})

describe('pasteSpritesAction', () => {
  it('does nothing when the clipboard is empty', () => {
    const store = createStore()
    store.set(allSpritesState, sprites('a'))

    const newIds = store.set(pasteSpritesAction)

    expect(newIds).toEqual([])
    expect(store.get(allSpritesState)).toEqual(sprites('a'))
    expect(store.get(selectedSpriteIdsState)).toEqual([])
  })

  it('creates copies with brand new ids shared by data and meta', () => {
    const store = createStore()
    const source = placeAt(sprites('a', 'b'), 30, 40)
    store.set(allSpritesState, source)
    store.set(copiedSpritesState, source)

    const newIds = store.set(pasteSpritesAction)

    expect(newIds).toHaveLength(2)
    expect(newIds).not.toContain('a')
    expect(newIds).not.toContain('b')
    // ids are unique
    expect(new Set(newIds).size).toBe(2)

    const result = store.get(allSpritesState)
    expect(result.datas.map((data) => data.id)).toEqual(['a', 'b', ...newIds])
    expect(result.metas.map((meta) => meta.id)).toEqual(['a', 'b', ...newIds])

    // Every copied data id has a matching meta id and vice versa
    for (const newId of newIds) {
      expect(result.datas.some((data) => data.id === newId)).toBe(true)
      expect(result.metas.some((meta) => meta.id === newId)).toBe(true)
      expect(store.get(spriteDatasWithId(newId)).id).toBe(newId)
      expect(store.get(spriteMetasWithId(newId)).id).toBe(newId)
    }
  })

  it('preserves the copied properties except for id and position', () => {
    const store = createStore()
    const source: Sprites = {
      datas: [
        {
          ...spriteData('a'),
          position: { x: 100, y: 200, z: 5 },
          rotation: 45 as Rotation,
          scale: { x: '2.0', y: '3.0', z: '1.0' },
          opacity: 0.4,
          locked: true,
          isStatic: true,
          weight: 42,
        },
      ],
      metas: [
        {
          ...spriteMeta('a'),
          assetId: 'asset-a',
          src: 'data:image/png;base64,abc',
          spriteWidth: 64,
          spriteHeight: 128,
        },
      ],
    }
    store.set(copiedSpritesState, source)

    const [newId] = store.set(pasteSpritesAction)
    const pastedData = store.get(spriteDatasWithId(newId))
    const pastedMeta = store.get(spriteMetasWithId(newId))

    expect(pastedData).toMatchObject({
      relativePath: 'a',
      rotation: 45,
      scale: { x: '2.0', y: '3.0', z: '1.0' },
      opacity: 0.4,
      locked: true,
      isStatic: true,
      weight: 42,
    })
    expect(pastedMeta).toMatchObject({
      assetId: 'asset-a',
      src: 'data:image/png;base64,abc',
      spriteWidth: 64,
      spriteHeight: 128,
    })
  })

  it('offsets the copies so they do not fully overlap the originals', () => {
    const store = createStore()
    const source = placeAt(sprites('a'), 100, 200)
    store.set(copiedSpritesState, source)

    const [newId] = store.set(pasteSpritesAction)
    const pastedData = store.get(spriteDatasWithId(newId))

    expect(pastedData.position).toEqual({
      x: 100 + PASTE_POSITION_OFFSET,
      y: 200 + PASTE_POSITION_OFFSET,
      z: 0,
    })
  })

  it('selects only the new copies after pasting', () => {
    const store = createStore()
    const source = sprites('a', 'b')
    store.set(allSpritesState, source)
    store.set(copiedSpritesState, source)
    store.set(selectedSpriteIdsState, ['a'])

    const newIds = store.set(pasteSpritesAction)

    expect(store.get(selectedSpriteIdsState)).toEqual(newIds)
    expect(store.get(selectedSpriteIdsState)).not.toContain('a')
    expect(store.get(selectedSpriteIdsState)).not.toContain('b')
  })

  it('produces independent copies that do not share nested state with the clipboard', () => {
    const store = createStore()
    const source = placeAt(sprites('a'), 10, 10)
    store.set(copiedSpritesState, source)

    const [newId] = store.set(pasteSpritesAction)
    store.set(spriteDatasWithId(newId), (data) => ({
      ...data,
      position: { ...data.position, x: 5000 },
    }))

    // Clipboard and any later paste are untouched by edits to the first copy
    expect(store.get(copiedSpritesState).datas[0].position.x).toBe(10)
    const [secondId] = store.set(pasteSpritesAction)
    expect(store.get(spriteDatasWithId(secondId)).position.x).toBe(10 + PASTE_POSITION_OFFSET)
    expect(secondId).not.toBe(newId)
  })

  it('can paste repeatedly without duplicating ids or re-selecting old copies', () => {
    const store = createStore()
    const source = sprites('a')
    store.set(copiedSpritesState, source)

    const firstIds = store.set(pasteSpritesAction)
    const secondIds = store.set(pasteSpritesAction)

    expect(firstIds).not.toEqual(secondIds)
    // Each paste adds one copy of the single clipboard sprite
    expect(store.get(spriteIdsState)).toHaveLength(2)
    expect(store.get(selectedSpriteIdsState)).toEqual(secondIds)
  })
})
