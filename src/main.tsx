import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getDefaultStore } from 'jotai'
import App from './App'
import './index.css'
import { inputManager } from './lib/inputManager'
import { audioManager } from './lib/audio'
import { playerStateAtom, screenAtom, currentStepAtom } from './atoms/gameAtoms'

if (import.meta.env.DEV) {
  // Small inspection surface for manual/e2e verification in development.
  const store = getDefaultStore()
  ;(window as unknown as Record<string, unknown>).__fingerDancer = {
    inputManager,
    audioManager,
    getSnapshot: () => ({
      screen: store.get(screenAtom),
      playerState: [...store.get(playerStateAtom)],
      currentStep: store.get(currentStepAtom),
      activeCodes: inputManager.getActiveCodes(),
      heldKeys: audioManager.getHeldKeys(),
      audioInitialized: audioManager.isInitialized(),
    }),
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)