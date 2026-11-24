import React, { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { AppContext } from '../../../context/AppContext'
import { copySpritesAction, pasteSpritesAction } from '../../../state/SpritesState'
import { useNotification } from '../../../hooks/useNotification'

interface Props {}

const CopyAndPasteListener = ({}: Props): React.JSX.Element => {
  const { hotkeys } = React.useContext(AppContext)
  const copySprites = useSetAtom(copySpritesAction)
  const pasteSprites = useSetAtom(pasteSpritesAction)
  const notify = useNotification()

  const onCopy = () => {
    // The action snapshots the current selection and returns how many it stored.
    const numberOfSprites = copySprites()
    if (numberOfSprites <= 0) return

    notify.success(`Copied ${numberOfSprites} sprite${numberOfSprites > 1 ? 's' : ''}`)
  }

  const onPaste = () => {
    // The action reads the clipboard at dispatch time, so there is no stale
    // state captured in this closure.
    const newIds = pasteSprites()
    if (newIds.length <= 0) return

    notify.success(`Pasted ${newIds.length} sprite${newIds.length > 1 ? 's' : ''}`)
  }

  useEffect(() => {
    hotkeys.copy?.subscribe(onCopy)
    hotkeys.paste?.subscribe(onPaste)
    return () => {
      hotkeys.copy?.unsubscribe(onCopy)
      hotkeys.paste?.unsubscribe(onPaste)
    }
  })

  return <></>
}

export default CopyAndPasteListener
