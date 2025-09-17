import React, { useEffect, useMemo, useState } from 'react';
import { BrowserProvider, Contract, formatUnits, parseUnits } from 'ethers';
import detectProvider from '@metamask/detect-provider';
import abi from './abi/VestiLock.abi.json';

// === CONFIG ===
const CHAIN_ID = 2741; // Abstract mainnet
const RPC_URL = 'https://api.mainnet.abs.xyz';
const DURATIONS = [30,60,90,120,180,210,240,270,300,330,360];
const FIXED_FEE_ETH = '0.015';
const CONTRACT_ADDRESS = import.meta.env.VITE_VESTI_ADDRESS || '0xYourDeployedContract';

/* ---------------- helpers ---------------- */

function hexChain(id){ return '0x' + Number(id).toString(16); }

async function ensureAbstractChain(provider, chainId = CHAIN_ID, rpcUrl = RPC_URL) {
  const wantHex = hexChain(chainId);
  let current = await provider.request({ method: 'eth_chainId' }).catch(() => null);
  if (!current || current.toLowerCase() !== wantHex.toLowerCase()) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: wantHex }] });
    } catch {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: wantHex,
          chainName: 'Abstract',
          rpcUrls: [rpcUrl],
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          blockExplorerUrls: ['https://abscan.org/']
        }]
      });
    }
  }
  current = await provider.request({ method: 'eth_chainId' }).catch(() => null);
  return current?.toLowerCase() === wantHex.toLowerCase();
}

async function wrapEthersFrom(provider) {
  const bp = new BrowserProvider(provider);
  const signer = await bp.getSigner();
  const accounts = await provider.request({ method: 'eth_accounts' }).catch(() => []);
  return { ethersProvider: bp, signer, account: accounts?.[0] || (await signer.getAddress()) };
}

// Try to find injected EIP-1193 providers, including AGW, MetaMask, Rabby, Phantom (EVM)
async function discoverInjectedProviders() {
  const out = [];

  // New multi-injected standard (EIP-6963)
  const addIfKnown = (prov) => {
    try {
      if (!prov) return;
      if (prov.isRabby) out.push({ id: 'rabby', name: 'Rabby', provider: prov });
      if (prov.isMetaMask) out.push({ id: 'metamask', name: 'MetaMask', provider: prov });
      // Generic entry if neither flag present (could be AGW or other EVM wallet)
      if (!prov.isRabby && !prov.isMetaMask) out.push({ id: 'injected', name: 'Injected Wallet', provider: prov });
    } catch {}
  };

  const agg = window?.ethereum?.providers;
  if (Array.isArray(agg)) agg.forEach(addIfKnown);
  else addIfKnown(window?.ethereum);

  // Phantom (EVM)
  if (typeof window !== 'undefined' && window.phantom?.ethereum) {
    out.push({ id: 'phantom', name: 'Phantom', provider: window.phantom.ethereum });
  }

  // Common AGW injections (covering current/older builds just in case)
  if (window?.agw?.ethereum) out.push({ id: 'agw', name: 'Abstract Global Wallet', provider: window.agw.ethereum });
  if (window?.abstract?.ethereum) out.push({ id: 'agw', name: 'Abstract Global Wallet', provider: window.abstract.ethereum });
  if (window?.abstractWallet?.provider) out.push({ id: 'agw', name: 'Abstract Global Wallet', provider: window.abstractWallet.provider });

  // Fallback MetaMask detect
  try {
    const mm = await detectProvider({ silent: true });
    if (mm && !out.find(x => x.provider === mm)) addIfKnown(mm);
  } catch {}

  // Deduplicate by provider object
  return out.filter((x, i, a) => a.findIndex(y => y.provider === x.provider) === i);
}

/* --------------- component --------------- */

export default function App(){
  // Wallet connection state
  const [account, setAccount] = useState(null);
  const [ethersProvider, setEthersProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [networkOk, setNetworkOk] = useState(false);

  // UI state
  const [token, setToken] = useState('');
  const [decimals, setDecimals] = useState(18);
  const [symbol, setSymbol] = useState('TOK');
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState(30);
  const [pending, setPending] = useState(false);
  const [confirmModal, setConfirmModal] = useState(false);
  const [walletModal, setWalletModal] = useState(false);
  const [providers, setProviders] = useState([]);
  const [positions, setPositions] = useState([]);

  // Build contract instance from current provider
  const vest = useMemo(() => {
    if (!ethersProvider) return null;
    return new Contract(CONTRACT_ADDRESS, abi, ethersProvider);
  }, [ethersProvider]);

  // Populate wallet choices on first open
  useEffect(() => {
    if (!walletModal) return;
    (async () => {
      const list = await discoverInjectedProviders();
      // Ensure we have at least a generic option if nothing detected
      setProviders(list.length ? list : []);
    })();
  }, [walletModal]);

  // Connect flows
  const connectVia = async (entry) => {
    try {
      if (!entry?.provider) throw new Error('No wallet provider found');
      // Ask for accounts first; some wallets require it before chain methods
      await entry.provider.request?.({ method: 'eth_requestAccounts' });
      const ok = await ensureAbstractChain(entry.provider);
      if (!ok) throw new Error('Failed to switch/add Abstract chain');
      const { ethersProvider, signer, account } = await wrapEthersFrom(entry.provider);
      setAccount(account);
      setEthersProvider(ethersProvider);
      setSigner(signer);
      setNetworkOk(true);
      setWalletModal(false);
    } catch (e) {
      alert(e?.message || 'Wallet connect failed');
    }
  };

  const disconnect = () => {
    // Injected wallets don’t have a programmatic disconnect. Clear local state.
    setAccount(null);
    setSigner(null);
    setEthersProvider(null);
    setNetworkOk(false);
    setPositions([]);
  };

  // Token metadata
  useEffect(() => {
    (async ()=>{
      if (!ethersProvider || !token || token.length !== 42) return;
      try {
        const erc20 = new Contract(token, [
          'function decimals() view returns (uint8)',
          'function symbol() view returns (string)'
        ], ethersProvider);
        const [d, s] = await Promise.all([
          erc20.decimals().catch(()=>18),
          erc20.symbol().catch(()=> 'TOK')
        ]);
        setDecimals(Number(d)); setSymbol(s);
      } catch {}
    })();
  }, [ethersProvider, token]);

  // Load recent positions by this account
  useEffect(() => {
    if (!vest || !account) return;
    const filter = vest.filters.Deposit(null, account);
    (async ()=>{
      try {
        const logs = await vest.queryFilter(filter, -50000, 'latest');
        const items = await Promise.all(logs.slice(-20).map(async (l) => {
          const id = l.args.id.toString();
          const pos = await vest.getPosition(id);
          return { id, token: pos.token, amount: pos.amount, unlockAt: Number(pos.unlockAt) };
        }));
        setPositions(items.reverse());
      } catch {}
    })();
  }, [vest, account]);

  // Ensure allowance then lock
  const ensureAllowance = async (erc20, needed) => {
    const allowance = await erc20.allowance(account, CONTRACT_ADDRESS);
    if (allowance >= needed) return;
    const tx = await erc20.connect(signer).approve(CONTRACT_ADDRESS, needed);
    await tx.wait();
  };

  const onLock = async () => {
    if (!signer) return alert('Connect a wallet first');
    const erc20 = new Contract(token, [
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 value) returns (bool)'
    ], ethersProvider);

    const amt = parseUnits((amount || '0').toString(), decimals);
    setPending(true);
    try {
      await ensureAllowance(erc20, amt);
      const vestW = vest.connect(signer);
      const tx = await vestW.lock(token, amt, days, { value: parseUnits(FIXED_FEE_ETH, 18) });
      setConfirmModal(false);
      await tx.wait();
    } catch (e) {
      alert(e?.shortMessage || e?.message || 'Transaction failed');
    } finally {
      setPending(false);
    }
  };

  const withdraw = async (id) => {
    if (!signer) return;
    setPending(true);
    try {
      const vestW = vest.connect(signer);
      const tx = await vestW.withdraw(id);
      await tx.wait();
      setPositions(p => p.filter(x => x.id !== id));
    } catch (e) {
      alert(e?.shortMessage || e?.message || 'Withdraw failed');
    } finally { setPending(false); }
  };

  const now = Math.floor(Date.now()/1000);

  return (
    <div className="shell">
      <div className="nav">
        <div className="brand">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#62f3a7" strokeWidth="2"/><path d="M7 13l3 3 7-7" stroke="#62f3a7" strokeWidth="2"/></svg>
          <span>tABS VestiLock</span>
          <span className="pill">Abstract · Mainnet</span>
        </div>
        <div className="row" style={{gap:8}}>
          {account ? (
            <>
              <span className="pill mono">{account.slice(0,6)}…{account.slice(-4)}</span>
              <button className="btn btn-ghost" onClick={disconnect}>Disconnect</button>
            </>
          ) : (
            <button className="btn btn-accent" onClick={() => setWalletModal(true)}>Connect Wallet</button>
          )}
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <h2>Lock Tokens</h2>
          <p className="muted">Lock ERC-20 tokens for a fixed time. Only the depositing wallet can withdraw after unlock.</p>
          <div className="hr" />
          <div>
            <label>Token address</label>
            <input placeholder="0x…" value={token} onChange={e=>setToken(e.target.value.trim())} />
          </div>
          <div className="row" style={{gap:12, marginTop:12}}>
            <div style={{flex:1}}>
              <label>Amount ({symbol})</label>
              <input type="number" min="0" step="any" value={amount} onChange={e=>setAmount(e.target.value)} />
            </div>
            <div style={{flex:1}}>
              <label>Duration (days)</label>
              <select value={days} onChange={e=>setDays(Number(e.target.value))}>
                {DURATIONS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>
          <div className="warn" style={{marginTop:12}}>
            <strong>Heads-up:</strong> You must include <span className="mono">{FIXED_FEE_ETH} ETH</span> with the lock transaction.
            Funds are escrowed in the contract; only the same wallet can withdraw. If you lose keys, funds are <strong>lost</strong>.
          </div>
          <div style={{display:'flex', gap:10, marginTop:12}}>
            <button className="btn btn-ghost" onClick={()=>setConfirmModal(true)} disabled={!account || !networkOk || !token || !amount || pending}>LOCK TOKENS</button>
          </div>
        </div>

        <div className="card">
          <h2>Your Positions</h2>
          <p className="muted">Connect your wallet to view the last 20 locks you created.</p>
          <div className="hr" />
          {(!account) && <div className="muted">Not connected.</div>}
          {(account && positions.length===0) && <div className="muted">No recent positions found.</div>}
          {positions.map((p) => {
            const left = Math.max(0, p.unlockAt - now);
            const ready = left === 0;
            return (
              <div key={p.id} style={{marginBottom:12, paddingBottom:12, borderBottom:'1px solid #1b2430'}}>
                <div className="row" style={{justifyContent:'space-between'}}>
                  <div>
                    <div className="mono">ID #{p.id}</div>
                    <div className="muted">Unlock {new Date(p.unlockAt*1000).toLocaleString()}</div>
                  </div>
                  <div className="row" style={{gap:6}}>
                    <span className="pill">{formatUnits(p.amount, decimals)} {symbol}</span>
                    {ready ? <span className="pill" style={{borderColor:'#27423a', background:'#0f1d18', color:'#8ff3b6'}}>Ready</span> : <span className="pill">{Math.ceil(left/86400)}d left</span>}
                  </div>
                </div>
                <div style={{marginTop:8}}>
                  <button className="btn btn-accent" disabled={!ready || pending} onClick={()=>withdraw(p.id)}>Withdraw</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Wallet picker */}
      {walletModal && (
        <div className="modal" onClick={()=>setWalletModal(false)}>
          <div className="card" onClick={e=>e.stopPropagation()}>
            <h3>Choose a wallet</h3>
            <div className="hr" />
            <div className="grid">
              {providers.length === 0 && <div className="muted">No wallets detected in this browser.</div>}
              {providers.map((p, i) => (
                <button key={i} className="btn btn-ghost" onClick={()=>connectVia(p)}>{p.name}</button>
              ))}
            </div>
            <p className="muted" style={{marginTop:12}}>
              Supports injected wallets (MetaMask, Rabby, Phantom EVM, AGW if injected). We’ll auto-switch to Abstract (2741).
            </p>
          </div>
        </div>
      )}

      {/* Confirm modal */}
      {confirmModal && (
        <div className="modal" onClick={()=>!pending && setConfirmModal(false)}>
          <div className="card" onClick={e=>e.stopPropagation()}>
            <h3>Confirm Lock</h3>
            <p className="muted">Read carefully before proceeding.</p>
            <div className="hr" />
            <ul>
              <li>Tokens will be transferred to a smart contract escrow on <strong>Abstract</strong>.</li>
              <li><strong>Only</strong> the same wallet that deposits can withdraw after the timer ends.</li>
              <li>If you lose access to your keys, <strong>funds are lost</strong>.</li>
              <li>You must include <span className="mono">{FIXED_FEE_ETH} ETH</span> in the transaction (non-refundable).</li>
            </ul>
            <div className="row" style={{justifyContent:'flex-end', marginTop:12}}>
              <button className="btn btn-ghost" disabled={pending} onClick={()=>setConfirmModal(false)}>Cancel</button>
              <button className="btn btn-accent" disabled={pending} onClick={onLock}>{pending? 'Working…':'I Understand, Lock Now'}</button>
            </div>
          </div>
        </div>
      )}

      <div style={{marginTop:24}} className="muted">
        <div>Made by<a href="https://x.com/totally_abs" target="_blank">The tABS Laboratory Team</a> 2025</div>
      </div>
    </div>
  );
}
