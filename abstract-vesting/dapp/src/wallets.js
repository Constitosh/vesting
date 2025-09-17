// dapp/src/wallets.js
import detectProvider from '@metamask/detect-provider';

/**
 * Discover injected EIP-1193 providers (EIP-6963 compatible).
 * Returns a list of { id, name, provider } for MetaMask, Rabby, Phantom (EVM).
 */
export async function discoverInjectedProviders() {
  // EIP-6963 (multi-wallet) – MetaMask/Rabby/etc emit events; also check common globals
  const out = [];

  // Phantom (EVM) detection
  if (typeof window !== 'undefined' && window.phantom?.ethereum) {
    out.push({ id: 'phantom', name: 'Phantom', provider: window.phantom.ethereum });
  }

  // Rabby exposes flags & may be in window.ethereum.providers
  const addIfRabby = (prov) => {
    try {
      if (!prov) return;
      // Rabby marks with isRabby, MetaMask with isMetaMask
      if (prov.isRabby) out.push({ id: 'rabby', name: 'Rabby', provider: prov });
      if (prov.isMetaMask) out.push({ id: 'metamask', name: 'MetaMask', provider: prov });
    } catch (_) {}
  };

  // Multi-provider array per EIP-6963
  const agg = window?.ethereum?.providers;
  if (Array.isArray(agg)) {
    agg.forEach(addIfRabby);
  } else {
    // Fallback: single provider path
    addIfRabby(window?.ethereum);
  }

  // Final fallback: metamask detect (also returns other injected sometimes)
  try {
    const mm = await detectProvider({ silent: true });
    if (mm && !out.find(x => x.provider === mm)) {
      addIfRabby(mm);
    }
  } catch (_) {}

  // De-dup by provider reference
  return out.filter((x, i, a) => a.findIndex(y => y.provider === x.provider) === i);
}

/**
 * Request accounts from chosen provider and ensure chain 2741 (Abstract).
 * If not on Abstract, prompt to add/switch.
 */
export async function connectWithProvider(provider, { chainId = 2741, rpcUrl = 'https://api.mainnet.abs.xyz' } = {}) {
  // Request accounts
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const account = accounts?.[0];

  // Check/switch chain
  let currentHex = await provider.request({ method: 'eth_chainId' });
  const wantHex = '0x' + chainId.toString(16);
  if (currentHex?.toLowerCase() !== wantHex.toLowerCase()) {
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: wantHex }],
      });
    } catch (err) {
      // If chain not added, add it
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: wantHex,
          chainName: 'Abstract',
          rpcUrls: [rpcUrl],
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          blockExplorerUrls: ['https://abscan.org/'],
        }],
      });
    }
  }

  // Re-fetch chain after switch
  currentHex = await provider.request({ method: 'eth_chainId' });

  // Make an ethers v6 BrowserProvider around this specific provider
  const { BrowserProvider } = await import('ethers');
  const ethersProvider = new BrowserProvider(provider);
  const signer = await ethersProvider.getSigner();

  return {
    account,
    chainIdHex: currentHex,
    ethersProvider,
    signer,
  };
}
