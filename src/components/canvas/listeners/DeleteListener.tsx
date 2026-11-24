import React, { useEffect } from 'react'
import { AppContext } from '../../../context/AppContext'
import { useSetAtom } from 'jotai'
import { deleteSelectedSpritesAction } from '../../../state/SpritesState'
import { useNotification } from '../../../hooks/useNotification'

interface Props {}

const DeleteListener = ({}: Props): React.JSX.Element => {
  const { hotkeys } = React.useContext(AppContext)
  const notify = useNotification()
  const deleteSelectedSprites = useSetAtom(deleteSelectedSpritesAction)

  const onDelete = () => {
    // The action reads the selection from state at dispatch time and removes
    // the sprites from the canvas and the selection together.
    const numberOfSprites = deleteSelectedSprites()
    if (numberOfSprites <= 0) return

    notify.success(`Deleted ${numberOfSprites} sprite${numberOfSprites > 1 ? 's' : ''}`)
  }

  useEffect(() => {
    hotkeys.delete?.subscribe(onDelete)
    return () => {
      hotkeys.delete?.unsubscribe(onDelete)
    }
  })

  return <></>
}

export default DeleteListener
