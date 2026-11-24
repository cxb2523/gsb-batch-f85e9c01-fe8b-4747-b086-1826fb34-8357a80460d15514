import { createStore, Provider } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import {
  selectedSpriteIdsState,
  spriteDatasWithId,
  spriteIdsState,
} from '../../../state/SpritesState'
import InspectorSection from './InspectorSection'

const renderInspector = (store: ReturnType<typeof createStore>) =>
  render(
    <Provider store={store}>
      <InspectorSection />
    </Provider>,
  )

afterEach(() => cleanup())

describe('InspectorSection', () => {
  it('renders nothing when no sprite is selected', () => {
    const store = createStore()
    store.set(spriteIdsState, ['a'])

    const { container } = renderInspector(store)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the selected id no longer exists on the canvas', () => {
    const store = createStore()
    store.set(spriteIdsState, ['a'])
    // Stale selection pointing at a sprite that was deleted
    store.set(selectedSpriteIdsState, ['deleted-id'])

    const { container } = renderInspector(store)

    expect(container).toBeEmptyDOMElement()
    // The stale id must not have caused a real sprite atom to be created
    expect(store.get(spriteIdsState)).toEqual(['a'])
  })
})
