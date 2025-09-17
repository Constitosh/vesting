import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

// AGW provider + chain
import { AbstractWalletProvider } from '@abstract-foundation/agw-react'
import { abstract } from 'viem/chains' // mainnet

createRoot(document.getElementById('root')).render(
  <AbstractWalletProvider chain={abstract}>
    <App />
  </AbstractWalletProvider>
)
