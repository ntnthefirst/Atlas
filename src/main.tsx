import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { migrateLegacyStorageKeys } from './utils/storageMigration'

// Runs before anything reads localStorage, so a user upgrading past the
// map -> environment rename (WP-0.7) keeps their task columns and card order.
// Every window loads this same entry, so one call covers all of them.
migrateLegacyStorageKeys()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
