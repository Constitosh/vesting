import React, { useEffect, useMemo, useState } from 'react';
import { BrowserProvider, Contract, formatUnits, parseUnits } from 'ethers';
import { useAccount, useChainId } from 'wagmi';
import { useLoginWithAbstract } from '@abstract-foundation/agw-react';
import AgwConnectButton from './components/AgwConnectButton.jsx';
import abi from './abi/VestiLock.abi.json';

// ====== CONFIG ======
const CHAIN_ID = 2741; // Abstract mainnet
const RPC_URL = 'https://api.mainnet.abs.xyz';
const DURATIONS = [30,60,90,120,180,210,240,270,300,330,360];
const FIXED_FEE_ETH = '0.015';
const CONTRACT_ADDRESS = import.meta.env.VITE_VESTI_ADDRESS || '0xYourDeployedContract';
const ALCHEMY_URL = import.meta.env.VITE_ALCHEMY_URL || 'https://abstract-mainnet.g.alchemy.com/v2/M2JFR2r4147ajgncDt4xV';

// ====== helpers ======
const hexChain = (id) => '0x' + Number(id).toString(16);
const AGW_ONLY = () =>
  (typeof window !== 'undefined') && (
    window.abstract?.ethereum ||
    window.agw?.ethereum ||
    window.abstractWallet?.provider ||
    null
  );

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

async function wrapEthers(provider) {
  const bp = new BrowserProvider(provider);
  const signer = await bp.getSigner();
  const accounts = await provider.request({ method: 'eth_accounts' }).catch(() => []);
  return { ethersProvider: bp, signer, account: accounts?.[0] || (await signer.getAddress()) };
}

function hexToBigIntSafe(h) {
  try { return (!h || h === '0x') ? 0n : BigInt(h); } catch { return 0n; }
}

function useIsNarrow(bp = 920) {
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < bp : false));
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < bp);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [bp]);
  return narrow;
}

// ====== component ======
export default function App(){
  const { isConnected, address } = useAccount();
  const connectedChainId = useChainId();          // wagmi source of truth
  const { logout } = useLoginWithAbstract();
  const isNarrow = useIsNarrow();

  // Local provider state
  const [account, setAccount] = useState(null);
  const [ethersProvider, setEthersProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [networkOk, setNetworkOk] = useState(false);

  // Positions / UI
  const [positions, setPositions] = useState([]);
  const [pending, setPending] = useState(false);
  const [confirmModal, setConfirmModal] = useState(false);

  // Token form state
  const [tokenMode, setTokenMode] = useState('dropdown'); // 'dropdown' | 'custom'
  const [tokenAddr, setTokenAddr] = useState('');
  const [decimals, setDecimals] = useState(18);
  const [symbol, setSymbol] = useState('TOK');
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState(30);

  // Alchemy balances
  const [detected, setDetected] = useState([]); // [{address,symbol,decimals,balanceRaw}]
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [includeZero, setIncludeZero] = useState(false);
  const [lastAlchemyErr, setLastAlchemyErr] = useState(null);

  // Contract instance
  const vest = useMemo(() => {
    if (!ethersProvider) return null;
    return new Contract(CONTRACT_ADDRESS, abi, ethersProvider);
  }, [ethersProvider]);

  // Bind to **AGW provider only** when wagmi shows connected
  useEffect(() => {
    (async () => {
      if (!isConnected || !address) {
        setAccount(null); setSigner(null); setEthersProvider(null); setNetworkOk(false);
        return;
      }
      const prov = AGW_ONLY();
      if (!prov) {
        console.warn('AGW provider not found in window.* (abstract/agw)');
        return;
      }
      try { await prov.request({ method: 'eth_requestAccounts' }); } catch {}
      const ok = await ensureAbstractChain(prov);
      const { ethersProvider, signer, account } = await wrapEthers(prov);

      setNetworkOk(ok);
      setAccount(account);
      setSigner(signer);
      setEthersProvider(ethersProvider);

      // keep in sync
      prov.on?.('accountsChanged', (accs)=> {
        const a = accs?.[0];
        setAccount(a || null);
        if (!a) {
          setSigner(null); setEthersProvider(null); setNetworkOk(false);
        }
      });
      prov.on?.('chainChanged', async ()=> {
        const ok2 = await ensureAbstractChain(prov);
        setNetworkOk(ok2);
      });
    })();
  }, [isConnected, address]);

  // Fetch ERC-20 balances from Alchemy once we have AGW provider, account, and correct chain
  const loadAlchemyTokens = async (addr) => {
    setLoadingTokens(true);
    setLastAlchemyErr(null);
    try {
      const body = {
        id: 1,
        jsonrpc: "2.0",
        method: "alchemy_getTokenBalances",
        params: [addr, "erc20"]
      };
      const res = await fetch(ALCHEMY_URL, {
        method: 'POST',
        headers: { 'Accept':'application/json', 'Content-Type':'application/json' },
        body: JSON.stringify(body)
      });
      const json = await res.json();

      if (!json?.result) {
        setDetected([]); setSelectedIdx(-1);
        setLastAlchemyErr(JSON.stringify(json));
        return;
      }

      const balances = Array.isArray(json.result.tokenBalances) ? json.result.tokenBalances : [];
      let items = balances.map((row) => ({
        address: row.contractAddress,
        balanceRaw: hexToBigIntSafe(row.tokenBalance),
        symbol: 'TOK',
        decimals: 18
      }));

      if (!includeZero) items = items.filter(t => t.balanceRaw > 0n);
      if (items.length === 0) { setDetected([]); setSelectedIdx(-1); return; }

      // Enrich meta from chain
      const metaAbi = [
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)'
      ];
      const enriched = await Promise.all(items.slice(0, 250).map(async (t) => {
        try {
          const c = new Contract(t.address, metaAbi, ethersProvider);
          const [d, s] = await Promise.all([
            c.decimals().catch(()=>18),
            c.symbol().catch(()=> 'TOK')
          ]);
          return { ...t, symbol: s, decimals: Number(d) };
        } catch { return t; }
      }));

      enriched.sort((a,b) => (b.balanceRaw > a.balanceRaw ? 1 : -1));
      setDetected(enriched);

      if (enriched.length) {
        setTokenMode('dropdown');
        setSelectedIdx(0);
        setTokenAddr(enriched[0].address);
        setSymbol(enriched[0].symbol);
        setDecimals(enriched[0].decimals);
      } else {
        setSelectedIdx(-1);
      }
    } catch (e) {
      setLastAlchemyErr(e?.message || String(e));
      setDetected([]); setSelectedIdx(-1);
      console.error('Alchemy fetch error', e);
    } finally {
      setLoadingTokens(false);
    }
  };

  // Load tokens when everything is ready AND we are on Abstract mainnet
  useEffect(() => {
    const onAbstract = connectedChainId === CHAIN_ID;
    if (!ethersProvider || !account || !networkOk || !onAbstract) {
      setDetected([]); setSelectedIdx(-1);
      return;
    }
    loadAlchemyTokens(account);
  }, [ethersProvider, account, networkOk, includeZero, connectedChainId]);

  // Keep token meta when selection/custom changes
  useEffect(() => {
    (async ()=>{
      if (!ethersProvider) return;
      if (tokenMode === 'dropdown') {
        if (selectedIdx < 0 || !detected[selectedIdx]) return;
        const t = detected[selectedIdx];
        setTokenAddr(t.address);
        setSymbol(t.symbol);
        setDecimals(t.decimals);
        return;
      }
      if (tokenAddr && tokenAddr.length === 42) {
        try {
          const c = new Contract(tokenAddr, [
            'function decimals() view returns (uint8)',
            'function symbol() view returns (string)'
          ], ethersProvider);
          const [d, s] = await Promise.all([
            c.decimals().catch(()=>18),
            c.symbol().catch(()=> 'TOK')
          ]);
          setDecimals(Number(d)); setSymbol(s);
        } catch {}
      }
    })();
  }, [tokenMode, selectedIdx, tokenAddr, ethersProvider, detected]);

  // Load recent positions
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

  // Lock / Withdraw
  const ensureAllowance = async (erc20, needed) => {
    const allowance = await erc20.allowance(account, CONTRACT_ADDRESS);
    if (allowance >= needed) return;
    const tx = await erc20.connect(signer).approve(CONTRACT_ADDRESS, needed);
    await tx.wait();
  };

  const onLock = async () => {
    if (!signer) return alert('Connect the Abstract Wallet first');
    const tokenToUse = tokenAddr;
    if (!tokenToUse || tokenToUse.length !== 42) return alert('Choose a token (or paste a valid address).');

    const erc20 = new Contract(tokenToUse, [
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 value) returns (bool)'
    ], ethersProvider);

    const amt = parseUnits((amount || '0').toString(), decimals);
    setPending(true);
    try {
      await ensureAllowance(erc20, amt);
      const vestW = vest.connect(signer);
      const tx = await vestW.lock(tokenToUse, amt, days, { value: parseUnits(FIXED_FEE_ETH, 18) });
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
  const isOnAbstract = connectedChainId === CHAIN_ID;

  // responsive grid
  const gridStyle = isNarrow
    ? { display: 'grid', gridTemplateColumns: '1fr', gap: 20 }
    : { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 };

  return (
    <div className="shell">
      {/* NAV */}
      <div className="nav">
        <div className="brand">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#62f3a7" strokeWidth="2"/><path d="M7 13l3 3 7-7" stroke="#62f3a7" strokeWidth="2"/></svg>
          <span>The tABS VestiLock</span>
          <span className="pill">Abstract · Mainnet</span>
        </div>
        <AgwConnectButton
          onConnected={async ()=> {
            const prov = AGW_ONLY();
            if (prov) {
              const ok = await ensureAbstractChain(prov);
              const { ethersProvider, signer, account } = await wrapEthers(prov);
              setNetworkOk(ok); setAccount(account); setSigner(signer); setEthersProvider(ethersProvider);
            } else {
              alert('Abstract Wallet not detected in this browser. Please open with AGW.');
            }
          }}
          onDisconnected={async ()=> {
            try { await logout?.(); } catch {}
            setAccount(null); setSigner(null); setEthersProvider(null); setNetworkOk(false);
            setDetected([]); setSelectedIdx(-1);
          }}
        />
      </div>

      {/* Status line */}
      <div className="muted" style={{margin:'4px 4px 12px'}}>
        acct: { (account || address) ? `${(account||address).slice(0,6)}…${(account||address).slice(-4)}` : '—' }
        {' · '}
        chain: {isOnAbstract ? '0xab5' : '— (need 0xab5)'}
      </div>

      {/* MAIN grid */}
      <div style={gridStyle}>
        {/* Lock card */}
        <div className="card">
          <h2>Lock Tokens</h2>
          <p className="muted">Lock ERC-20 tokens for a fixed time. Only the depositing wallet can withdraw after unlock.</p>
          <div className="hr" />

          <div className="row" style={{gap:12, alignItems:'end', flexWrap:'wrap'}}>
            <div style={{flex: '1 1 180px'}}>
              <label>Token source</label>
              <select value={tokenMode} onChange={e=>setTokenMode(e.target.value)}>
                <option value="dropdown">My wallet tokens (Alchemy)</option>
                <option value="custom">Custom token address…</option>
              </select>
            </div>

            {tokenMode === 'dropdown' && (
              <>
                <div style={{flex: '2 1 260px'}}>
                  <label>Choose token {loadingTokens && <span className="muted">(loading…)</span>}</label>
                  <select
                    value={String(selectedIdx)}
                    onChange={(e)=>setSelectedIdx(Number(e.target.value))}
                    disabled={!isOnAbstract}
                  >
                    {(!loadingTokens && detected.length === 0) && <option value="-1">— none detected —</option>}
                    {detected.map((t, i) => (
                      <option key={t.address} value={String(i)}>
                        {t.symbol} — {t.address.slice(0,6)}…{t.address.slice(-4)} ({formatUnits(t.balanceRaw, t.decimals)} {t.symbol})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="row" style={{gap:10, flex: '1 1 220px'}}>
                  <button className="btn btn-ghost" onClick={()=>account && loadAlchemyTokens(account)} disabled={!account || loadingTokens || !isOnAbstract}>Reload tokens</button>
                  <label className="muted" style={{display:'flex', alignItems:'center', gap:6}}>
                    <input type="checkbox" checked={includeZero} onChange={e=>setIncludeZero(e.target.checked)} />
                    Include zero balances
                  </label>
                </div>
              </>
            )}

            {tokenMode === 'custom' && (
              <div style={{flex: '2 1 260px'}}>
                <label>Token address</label>
                <input placeholder="0x…" value={tokenAddr} onChange={e=>setTokenAddr(e.target.value.trim())} />
              </div>
            )}
          </div>

          {lastAlchemyErr && (
            <div className="muted" style={{marginTop:8, fontSize:12}}>
              Alchemy note: {String(lastAlchemyErr).slice(0,220)}{String(lastAlchemyErr).length>220?'…':''}
            </div>
          )}

          <div className="row" style={{gap:12, marginTop:12, flexWrap:'wrap'}}>
            <div style={{flex:'1 1 200px'}}>
              <label>Amount ({symbol})</label>
              <input type="number" min="0" step="any" value={amount} onChange={e=>setAmount(e.target.value)} />
            </div>
            <div style={{flex:'1 1 200px'}}>
              <label>Duration (days)</label>
              <select value={days} onChange={e=>setDays(Number(e.target.value))}>
                {DURATIONS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>

          <div className="warn" style={{marginTop:12}}>
            <strong>Heads-up:</strong> Include <span className="mono">{FIXED_FEE_ETH} ETH</span> with the lock tx.
            Funds are escrowed; only the same wallet can withdraw. If you lose keys, funds are <strong>lost</strong>.
          </div>

          <div style={{display:'flex', gap:10, marginTop:12}}>
            <button
              className="btn btn-ghost"
              onClick={()=>setConfirmModal(true)}
              disabled={!isConnected || !networkOk || !isOnAbstract || pending ||
                        (tokenMode==='dropdown' && (selectedIdx<0 || !detected[selectedIdx])) ||
                        (tokenMode==='custom' && (!tokenAddr || tokenAddr.length!==42)) ||
                        !amount}
            >
              LOCK TOKENS
            </button>
          </div>
        </div>

        {/* Positions */}
        <div className="card">
          <h2>Your Positions</h2>
          <p className="muted">Connect your wallet to view the last 20 locks you created.</p>
          <div className="hr" />
          {(!(account || address)) && <div className="muted">Not connected.</div>}
          {((account || address) && positions.length===0) && <div className="muted">No recent positions found.</div>}
          {positions.map((p) => {
            const left = Math.max(0, p.unlockAt - now);
            const ready = left === 0;
            return (
              <div key={p.id} style={{marginBottom:12, paddingBottom:12, borderBottom:'1px solid #1b2430'}}>
                <div className="row" style={{justifyContent:'space-between', flexWrap:'wrap', gap:8}}>
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
              <li>Include <span className="mono">{FIXED_FEE_ETH} ETH</span> (non-refundable).</li>
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
