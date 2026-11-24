import { atom, type SetStateAction } from 'jotai'
import { atomFamily } from 'jotai-family'
import { cloneDeep } from 'lodash'
import { v4 as uuidv4 } from 'uuid'
import { PASTE_POSITION_OFFSET } from '../constants'
import { SpriteData } from '../model/SpriteData'
import { SpriteMeta } from '../model/SpriteMeta'

/**
 * Ids
 */

export const spriteIdsState = atom<string[]>([])

export const selectedSpriteIdsState = atom<string[]>([])

/**
 * Sprite data and meta, one atom per sprite id
 */

export const spriteDatasWithId = atomFamily((_id: string) => atom<SpriteData>(SpriteData.default()))

export const spriteMetasWithId = atomFamily((_id: string) => atom<SpriteMeta>(SpriteMeta.default()))

/**
 * Combined
 */

export const allSpritesState = atom(
  (get): Sprites => {
    const ids = get(spriteIdsState)
    const datas = ids.map((id) => get(spriteDatasWithId(id)))
    const metas = ids.map((id) => get(spriteMetasWithId(id)))
    return { datas, metas }
  },
  (get, set, update: SetStateAction<Sprites>) => {
    const { datas, metas } = typeof update === 'function' ? update(get(allSpritesState)) : update
    for (const data of datas) set(spriteDatasWithId(data.id), data)
    for (const meta of metas) set(spriteMetasWithId(meta.id), meta)
    set(
      spriteIdsState,
      datas.map((data) => data.id),
    )
  },
)

export const copiedSpritesState = atom<Sprites>({
  metas: [],
  datas: [],
})

export const selectedSpritesState = atom((get): Sprites => {
  const ids = get(selectedSpriteIdsState)
  const datas = ids.map((id) => get(spriteDatasWithId(id)))
  const metas = ids.map((id) => get(spriteMetasWithId(id)))
  return { datas, metas }
})

/**
 * Actions
 */

export const addSpriteAction = atom(
  null,
  (_get, set, id: string, spriteData: SpriteData, spriteMeta: SpriteMeta) => {
    set(spriteIdsState, (ids) => [...ids, id])
    set(spriteDatasWithId(id), spriteData)
    set(spriteMetasWithId(id), spriteMeta)
  },
)

/**
 * Stores an independent snapshot of the currently selected sprites on the
 * clipboard. The snapshot is deep-cloned, so later edits to or deletion of
 * the source sprites can never mutate or invalidate what can be pasted.
 * Returns the number of sprites that were copied (0 when nothing is selected).
 */
export const copySpritesAction = atom(null, (get, set): number => {
  const spritesToCopy = get(selectedSpritesState)
  if (spritesToCopy.datas.length <= 0) return 0

  set(copiedSpritesState, cloneDeep(spritesToCopy))
  return spritesToCopy.datas.length
})

/**
 * Duplicates every sprite held on the clipboard:
 * - each copy gets a brand new id, shared by its SpriteData and SpriteMeta
 * - every copy is shifted by a visible offset so it never fully overlaps
 *   the sprite it was duplicated from
 * - only the freshly created copies end up selected
 * Returns the ids of the new copies (empty when the clipboard has no sprites).
 */
export const pasteSpritesAction = atom(null, (get, set): string[] => {
  const copiedSprites = get(copiedSpritesState)
  if (copiedSprites.datas.length <= 0) return []

  // Pair each data with its meta by id so data/meta ids stay consistent.
  const metasById = new Map(copiedSprites.metas.map((meta) => [meta.id, meta]))

  const newDatas: SpriteData[] = []
  const newMetas: SpriteMeta[] = []
  const newIds: string[] = []

  for (const data of copiedSprites.datas) {
    const newId = uuidv4()
    newIds.push(newId)

    const meta = metasById.get(data.id)
    if (!meta) {
      throw new Error(`Missing runtime meta for copied sprite ${data.id}`)
    }

    newDatas.push({
      ...cloneDeep(data),
      id: newId,
      position: {
        x: data.position.x + PASTE_POSITION_OFFSET,
        y: data.position.y + PASTE_POSITION_OFFSET,
        z: data.position.z,
      },
    })
    newMetas.push({ ...cloneDeep(meta), id: newId })
  }

  set(allSpritesState, (allSprites) => ({
    datas: [...allSprites.datas, ...newDatas],
    metas: [...allSprites.metas, ...newMetas],
  }))
  set(selectedSpriteIdsState, newIds)

  return newIds
})

/**
 * Removes the given sprites from the canvas and prunes any of their ids from
 * the current selection, so no selected id can ever point at a missing sprite.
 * The clipboard is intentionally left untouched: it holds an independent
 * snapshot and must remain pasteable after its sources are deleted.
 */
export const deleteSpritesAction = atom(null, (_get, set, ids: string[]) => {
  const idsToDelete = new Set(ids)

  set(allSpritesState, (allSprites) => ({
    datas: allSprites.datas.filter((data) => !idsToDelete.has(data.id)),
    metas: allSprites.metas.filter((meta) => !idsToDelete.has(meta.id)),
  }))
  set(selectedSpriteIdsState, (selectedIds) =>
    selectedIds.filter((selectedId) => !idsToDelete.has(selectedId)),
  )
})

/**
 * Deletes every currently selected sprite, removing them from both the canvas
 * and the selection in one go. Reads the selection from state at dispatch time
 * (rather than a component closure) so it can never act on stale ids.
 * The clipboard is untouched and remains pasteable.
 * Returns the number of sprites that were deleted.
 */
export const deleteSelectedSpritesAction = atom(null, (get, set): number => {
  const selectedIds = get(selectedSpriteIdsState)
  if (selectedIds.length <= 0) return 0

  set(deleteSpritesAction, selectedIds)
  return selectedIds.length
})
