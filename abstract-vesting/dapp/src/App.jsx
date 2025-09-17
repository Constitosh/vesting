import React, { useEffect, useMemo, useState } from 'react';
import { BrowserProvider, Contract, formatUnits, parseUnits } from 'ethers';
import { useLoginWithAbstract } from '@abstract-foundation/agw-react';
import abi from './abi/VestiLock.abi.json';

// === CONFIG ===
const CHAIN_ID = 2741; // Abstract mainnet
const RPC_URL = 'https://api.mainnet.abs.xyz';
const DURATIONS = [30,60,90,120,180,210,240,270,300,330,360];
const FIXED_FEE_ETH = '0.015';
const CONTRACT_ADDRESS = import.meta.env.VITE_VESTI_ADDRESS || '0xYourDeployedContract';

// ---------- helpers ----------
const hexChain = (id) => '0x' + Number(id).toString(16);

function getAgwInjected() {
  if (typeof window === 'undefined') return null;
  return (
    window.agw?.ethereum ||
    window.abstract?.ethereum ||
    window.abstractWallet?.provider ||
    null
  );
}

async function ensureAbstractChain(provider) {
  const wantHex = hexChain(CHAIN_ID);
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
          rpcUrls: [RPC_URL],
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          blockExplorerUrls: ['https://abscan.org/']
        }]
      });
    }
  }
  current = await provider.request({ method: 'eth_chainId' }).catch(() => null);
  return current?.toLowerCase() === wantHex.toLowerCase();
}

async function toEthers(provider) {
  const bp = new BrowserProvider(provider);
  const signer = await bp.getSigner();
  const accounts = await provider.request({ method: 'eth_accounts' }).catch(() => []);
  return { ethersProvider: bp, signer, account: accounts?.[0] || (await signer.getAddress()) };
}

// ---------- component ----------
export default function App(){
  const { login, logout } = useLoginWithAbstract(); // official AGW auth hook
  const [account, setAccount] = useState(null);
  const [ethersProvider, setEthersProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [networkOk, setNetworkOk] = useState(false);

  const [token, setToken] = useState('');
  const [decimals, setDecimals] = useState(18);
  const [symbol, setSymbol] = useState('TOK');
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState(30);
  const [pending, setPending] = useState(false);
  const [confirmModal, setConfirmModal] = useState(false);
  const [positions, setPositions] = useState([]);

  // Contract instance
  const vest = useMemo(() => {
    if (!ethersProvider) return null;
    return new Contract(CONTRACT_ADDRESS, abi, ethersProvider);
  }, [ethersProvider]);

  // Connect via AGW button
  const connectAGW = async () => {
    try {
      await login(); // opens AGW modal (create/login). Official flow.  :contentReference[oaicite:5]{index=5}

      const agw = getAgwInjected();
      if (!agw) throw new Error('Abstract Wallet provider not found in this browser');

      await agw.request?.({ method: 'eth_requestAccounts' });
      const ok = await ensureAbstractChain(agw);
      if (!ok) throw new Error('Failed to switch/add Abstract');

      const { ethersProvider, signer, account } = await toEthers(agw);
      setAccount(account);
      setEthersProvider(ethersProvider);
      setSigner(signer);
      setNetworkOk(true);
    } catch (e) {
      alert(e?.message || 'Abstract Wallet connect failed');
    }
  };

  const disconnect = async () => {
    try { await logout?.(); } catch {}
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
    if (!signer) return alert('Connect the Abstract Wallet first');
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
          <span>The tABS VestiLock</span>
          <span className="pill">Abstract · Mainnet</span>
        </div>
        <div className="row" style={{gap:8}}>
          {account ? (
            <>
              <span className="pill mono">{account.slice(0,6)}…{account.slice(-4)}</span>
              <button className="btn btn-ghost" onClick={disconnect}>Disconnect</button>
            </>
          ) : (
            <button className="btn btn-accent" onClick={connectAGW}>Connect Abstract Wallet</button>
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
        <div>Made by <a href="https://x.com/totally_abs" target="_blank">The tABS Laboratory Team</a> 2025</div>
      </div>
    </div>
  );
}
