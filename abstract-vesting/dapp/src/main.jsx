// dapp/src/main.jsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

// AGW + Query setup
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgwProvider } from '@abstract-foundation/agw-react';

const qc = new QueryClient();

createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={qc}>
    <AgwProvider>
      <App />
    </AgwProvider>
  </QueryClientProvider>
);
