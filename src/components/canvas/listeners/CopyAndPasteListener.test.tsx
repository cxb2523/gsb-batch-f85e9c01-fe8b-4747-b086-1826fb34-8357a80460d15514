import { createStore, Provider } from 'jotai'
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { HotkeyNotifier } from '../../../service/HotkeyNotifier'
import { AppContext, type AppContextProps } from '../../../context/AppContext'
import { SpriteData } from '../../../model/SpriteData'
import { SpriteMeta } from '../../../model/SpriteMeta'
import {
  allSpritesState,
  copiedSpritesState,
  selectedSpriteIdsState,
  spriteIdsState,
} from '../../../state/SpritesState'
import { PASTE_POSITION_OFFSET } from '../../../constants'
import CopyAndPasteListener from './CopyAndPasteListener'
import DeleteListener from './DeleteListener'

const spriteData = (id: string, x = 0, y = 0): SpriteData => ({
  ...SpriteData.default(),
  id,
  relativePath: id,
  position: { x, y, z: 0 },
})
const spriteMeta = (id: string): SpriteMeta => ({ ...SpriteMeta.default(), id, name: id })

interface HarnessProps {
  hotkeys: HotkeyNotifier
  children: React.ReactNode
}

// Memoised so the context value keeps a stable reference across re-renders.
const Harness = ({ hotkeys, children }: HarnessProps): React.JSX.Element => {
  const contextValue = React.useMemo<AppContextProps>(
    () => ({ dragAndDropRef: React.createRef(), hotkeys }),
    [hotkeys],
  )
  return <AppContext.Provider value={contextValue}>{children}</AppContext.Provider>
}

const renderListeners = (store: ReturnType<typeof createStore>, hotkeys: HotkeyNotifier) =>
  render(
    <Provider store={store}>
      <Harness hotkeys={hotkeys}>
        <CopyAndPasteListener />
        <DeleteListener />
      </Harness>
    </Provider>,
  )

afterEach(() => cleanup())

describe('copy / paste / delete hotkey chain', () => {
  it('copies a snapshot, pastes detached copies, then deletes without breaking the clipboard', () => {
    const store = createStore()
    const hotkeys = new HotkeyNotifier()
    store.set(allSpritesState, {
      datas: [spriteData('a', 10, 20), spriteData('b', 30, 40)],
      metas: [spriteMeta('a'), spriteMeta('b')],
    })
    store.set(selectedSpriteIdsState, ['a', 'b'])
    renderListeners(store, hotkeys)

    // Copy
    hotkeys.copy?.notify('CommandOrControl+C', 'event-1')
    const clipboardAfterCopy = store.get(copiedSpritesState)
    expect(clipboardAfterCopy.datas.map((data) => data.id)).toEqual(['a', 'b'])

    // Paste: new ids, offset positions and only the copies selected
    hotkeys.paste?.notify('CommandOrControl+V', 'event-2')
    const idsAfterPaste = store.get(spriteIdsState)
    expect(idsAfterPaste).toHaveLength(4)
    const selectedAfterPaste = store.get(selectedSpriteIdsState)
    expect(selectedAfterPaste).toHaveLength(2)
    expect(selectedAfterPaste.some((id) => ['a', 'b'].includes(id))).toBe(false)

    const pastedData = store
      .get(allSpritesState)
      .datas.filter((data) => !['a', 'b'].includes(data.id))
    expect(pastedData.map((data) => data.position)).toEqual([
      { x: 10 + PASTE_POSITION_OFFSET, y: 20 + PASTE_POSITION_OFFSET, z: 0 },
      { x: 30 + PASTE_POSITION_OFFSET, y: 40 + PASTE_POSITION_OFFSET, z: 0 },
    ])

    // Delete the selected (pasted) sprites: removed from canvas and selection
    hotkeys.delete?.notify('Delete', 'event-3')
    expect(store.get(spriteIdsState)).toEqual(['a', 'b'])
    expect(store.get(selectedSpriteIdsState)).toEqual([])

    // Clipboard still holds the independent snapshot and remains pasteable
    expect(store.get(copiedSpritesState)).toEqual(clipboardAfterCopy)
    hotkeys.paste?.notify('CommandOrControl+V', 'event-4')
    expect(store.get(spriteIdsState)).toHaveLength(4)
    expect(store.get(selectedSpriteIdsState)).toHaveLength(2)
  })

  it('ignores copy and paste when there is nothing to copy or paste', () => {
    const store = createStore()
    const hotkeys = new HotkeyNotifier()
    renderListeners(store, hotkeys)

    hotkeys.copy?.notify('CommandOrControl+C', 'event-1')
    expect(store.get(copiedSpritesState)).toEqual({ datas: [], metas: [] })

    hotkeys.paste?.notify('CommandOrControl+V', 'event-2')
    expect(store.get(spriteIdsState)).toEqual([])
    expect(store.get(selectedSpriteIdsState)).toEqual([])
  })

  it('ignores delete when nothing is selected', () => {
    const store = createStore()
    const hotkeys = new HotkeyNotifier()
    store.set(allSpritesState, { datas: [spriteData('a')], metas: [spriteMeta('a')] })
    renderListeners(store, hotkeys)

    hotkeys.delete?.notify('Delete', 'event-1')

    expect(store.get(spriteIdsState)).toEqual(['a'])
    expect(store.get(selectedSpriteIdsState)).toEqual([])
  })
})
