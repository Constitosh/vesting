import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

// Official provider (brings wagmi + TanStack Query under the hood)
import { AbstractWalletProvider } from '@abstract-foundation/agw-react'
import { abstract } from 'viem/chains' // Abstract mainnet

createRoot(document.getElementById('root')).render(
  <AbstractWalletProvider chain={abstract}>
    <App />
  </AbstractWalletProvider>
)
