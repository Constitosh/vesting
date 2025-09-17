import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserProvider, Contract, formatUnits, parseUnits } from 'ethers';
import { useAccount } from 'wagmi';
import { useLoginWithAbstract } from '@abstract-foundation/agw-react';
import AgwConnectButton from './components/AgwConnectButton.jsx';
import abi from './abi/VestiLock.abi.json';

/* =========================
   CONFIG (Abstract only)
   ========================= */
const CHAIN_ID = 2741; // Abstract mainnet
const RPC_URL = 'https://api.mainnet.abs.xyz';
const DURATIONS = [30,60,90,120,180,210,240,270,300,330,360];
const FIXED_FEE_ETH = '0.015';
const CONTRACT_ADDRESS = import.meta.env.VITE_VESTI_ADDRESS || '0xYourDeployedContract';
const ALCHEMY_URL = import.meta.env.VITE_ALCHEMY_URL || 'https://abstract-mainnet.g.alchemy.com/v2/M2JFR2r4147ajgncDt4xV';

/* =========================
   HELPERS
   ========================= */
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

async function mapLimit(arr, limit, fn) {
  const ret = new Array(arr.length);
  let i = 0;
  const workers = Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= arr.length) break;
      ret[idx] = await fn(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return ret;
}

/* Force-ensure Abstract now (best-effort, safe to call anytime) */
async function switchToAbstract() {
  const prov = AGW_ONLY();
  if (!prov) throw new Error('Abstract Wallet provider not found.');
  await ensureAbstractChain(prov);
  return prov;
}

/* =========================
   APP
   ========================= */
export default function App(){
  const { isConnected, address } = useAccount(); // wagmi still gives us the address
  const { logout } = useLoginWithAbstract();
  const isNarrow = useIsNarrow();

  // Provider state
  const [account, setAccount] = useState(null);
  const [ethersProvider, setEthersProvider] = useState(null);
  const [signer, setSigner] = useState(null);

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

  // Token list (Alchemy + DexScreener)
  const [detected, setDetected] = useState([]); // [{address, balanceRaw, decimals, symbol, name?, logo?}]
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [includeZero, setIncludeZero] = useState(false);
  const [lastErr, setLastErr] = useState(null);

  // Contract instance
  const vest = useMemo(() => {
    if (!ethersProvider) return null;
    return new Contract(CONTRACT_ADDRESS, abi, ethersProvider);
  }, [ethersProvider]);

  /* Bind to AGW and force Abstract on connect */
  useEffect(() => {
    (async () => {
      if (!isConnected || !address) {
        setAccount(null); setSigner(null); setEthersProvider(null);
        return;
      }
      try {
        const prov = await switchToAbstract();
        try { await prov.request({ method: 'eth_requestAccounts' }); } catch {}
        const { ethersProvider, signer, account } = await wrapEthers(prov);
        setAccount(account);
        setSigner(signer);
        setEthersProvider(ethersProvider);

        // keep in sync
        prov.on?.('accountsChanged', (accs)=> {
          const a = accs?.[0];
          setAccount(a || null);
          if (!a) { setSigner(null); setEthersProvider(null); }
        });
        prov.on?.('chainChanged', async ()=> {
          // Always snap back to Abstract if something changes
          try { await ensureAbstractChain(prov); } catch {}
        });
      } catch (e) {
        console.warn('AGW/Abstract init:', e);
      }
    })();
  }, [isConnected, address]);

  /* ===== Alchemy balances + DexScreener metadata ===== */
  async function loadTokensFor(walletAddress) {
    setLoadingTokens(true);
    setLastErr(null);
    try {
      // 1) balances from Alchemy
      const balancesBody = {
        id: 1, jsonrpc: "2.0", method: "alchemy_getTokenBalances",
        params: [walletAddress, "erc20"]
      };
      const balancesRes = await fetch(ALCHEMY_URL, {
        method: "POST",
        mode: "cors",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(balancesBody),
      });
      const balancesJson = await balancesRes.json();
      const rows = Array.isArray(balancesJson?.result?.tokenBalances)
        ? balancesJson.result.tokenBalances
        : [];

      // 2) normalize + filter
      const baseItems = rows
        .map(r => ({
          address: r.contractAddress,
          balanceRaw: hexToBigIntSafe(r.tokenBalance || "0x0"),
        }))
        .filter(t => includeZero ? true : t.balanceRaw > 0n);

      const items = baseItems.slice(0, 150);
      if (items.length === 0) {
        setDetected([]); setSelectedIdx(-1);
        return;
      }

      // helpers
      const fetchAlchemyMeta = async (ca) => {
        const metaBody = { id: 1, jsonrpc: "2.0", method: "alchemy_getTokenMetadata", params: [ca] };
        const r = await fetch(ALCHEMY_URL, {
          method: "POST",
          mode: "cors",
          headers: { "Accept": "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(metaBody),
        });
        const j = await r.json();
        const m = j?.result || {};
        return {
          symbol: typeof m.symbol === "string" && m.symbol.length ? m.symbol : "TOK",
          decimals: Number.isFinite(m.decimals) ? Number(m.decimals) : 18,
          name: typeof m.name === "string" ? m.name : undefined,
          logo: m.logo || null,
        };
      };

      const fetchDexMeta = async (ca) => {
        const url = `https://api.dexscreener.com/tokens/v1/abstract/${ca}`;
        const r = await fetch(url, { mode: 'cors' });
        if (!r.ok) return null;
        const arr = await r.json();
        const first = Array.isArray(arr) && arr.length ? arr[0] : null;
        if (!first) return null;
        const base = first.baseToken || {};
        const info = first.info || {};
        return {
          symbol: base.symbol || null,
          name: base.name || null,
          logo: info.imageUrl || null,
        };
      };

      // 3) enrich
      const enriched = await mapLimit(items, 8, async (t) => {
        let dex = null;
        try { dex = await fetchDexMeta(t.address); } catch {}
        let al = null;
        try { al = await fetchAlchemyMeta(t.address); } catch {}

        const symbol = (dex?.symbol || al?.symbol || 'TOK');
        const name = (dex?.name || al?.name);
        const logo = (dex?.logo || al?.logo || null);
        const decimals = Number.isFinite(al?.decimals) ? al.decimals : 18;

        return { ...t, symbol, name, logo, decimals };
      });

      enriched.sort((a,b) => (b.balanceRaw > a.balanceRaw ? 1 : -1));
      setDetected(enriched);
      if (enriched.length) {
        setTokenMode("dropdown");
        setSelectedIdx(0);
        setTokenAddr(enriched[0].address);
        setSymbol(enriched[0].symbol || 'TOK');
        setDecimals(Number.isFinite(enriched[0].decimals) ? enriched[0].decimals : 18);
      } else {
        setSelectedIdx(-1);
      }
    } catch (e) {
      console.error(e);
      setLastErr(e?.message || String(e));
      setDetected([]); setSelectedIdx(-1);
    } finally {
      setLoadingTokens(false);
    }
  }

  /* Load tokens as soon as we know ANY address (wagmi or AGW) */
  useEffect(() => {
    const wal = account || address;
    if (!wal) { setDetected([]); setSelectedIdx(-1); return; }
    loadTokensFor(wal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, address, includeZero, ALCHEMY_URL]);

  /* Keep token meta when selection/custom changes */
  useEffect(() => {
    if (tokenMode === 'dropdown') {
      if (selectedIdx < 0 || !detected[selectedIdx]) return;
      const t = detected[selectedIdx];
      setTokenAddr(t.address);
      setSymbol(t.symbol || 'TOK');
      setDecimals(Number.isFinite(t.decimals) ? t.decimals : 18);
      return;
    }
  }, [tokenMode, selectedIdx, detected]);

  /* Positions */
  useEffect(() => {
    if (!vest || !(account || address)) return;
    const who = account || address;
    const filter = vest.filters.Deposit(null, who);
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
  }, [vest, account, address]);

  /* Lock / Withdraw */
  const ensureAllowance = async (erc20, needed) => {
    const owner = (account || address);
    const allowance = await erc20.allowance(owner, CONTRACT_ADDRESS);
    if (allowance >= needed) return;
    const tx = await erc20.connect(signer).approve(CONTRACT_ADDRESS, needed);
    await tx.wait();
  };

  const onLock = async () => {
    if (!signer) return alert('Connect the Abstract Wallet first');
    // Always ensure Abstract right before sending
    try { await switchToAbstract(); } catch { return alert('Open with Abstract Wallet.'); }

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
    try { await switchToAbstract(); } catch { return alert('Open with Abstract Wallet.'); }
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
  const gridStyle = isNarrow
    ? { display: 'grid', gridTemplateColumns: '1fr', gap: 20 }
    : { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 };

  // Custom dropdown state (with logos)
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef(null);
  useEffect(() => {
    const onClick = (e) => {
      if (!dropdownRef.current) return;
      if (!dropdownRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  const selected = (tokenMode === 'dropdown' && selectedIdx >= 0) ? detected[selectedIdx] : null;

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
            try {
              const prov = await switchToAbstract();
              const { ethersProvider, signer, account } = await wrapEthers(prov);
              setAccount(account); setSigner(signer); setEthersProvider(ethersProvider);
            } catch {
              alert('Abstract Wallet not detected in this browser.');
            }
          }}
          onDisconnected={async ()=> {
            try { await logout?.(); } catch {}
            setAccount(null); setSigner(null); setEthersProvider(null);
            setDetected([]); setSelectedIdx(-1);
          }}
        />
      </div>

      {/* Status */}
      <div className="muted" style={{margin:'4px 4px 12px'}}>
        acct: { (account || address) ? `${(account||address).slice(0,6)}…${(account||address).slice(-4)}` : '—' } · chain: 0xab5
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
                <option value="dropdown">My wallet tokens</option>
                <option value="custom">Custom token address…</option>
              </select>
            </div>

            {tokenMode === 'dropdown' && (
              <>
                {/* Custom dropdown with logos */}
                <div style={{flex: '2 1 360px'}} ref={dropdownRef}>
                  <label>Choose token {loadingTokens && <span className="muted">(loading…)</span>}</label>
                  <div className="dropdown">
                    <button className="btn btn-ghost" style={{width:'100%', justifyContent:'space-between'}} onClick={()=>setOpen(v=>!v)}>
                      <div style={{display:'flex', alignItems:'center', gap:8, overflow:'hidden'}}>
                        {selected?.logo && <img src={selected.logo} alt="" width="20" height="20" style={{borderRadius:4, flex:'0 0 auto'}} />}
                        <span className="mono" style={{whiteSpace:'nowrap', textOverflow:'ellipsis', overflow:'hidden'}}>
                          {selected ? `${selected.symbol || 'TOK'} — ${selected.address.slice(0,6)}…${selected.address.slice(-4)}` : '— none detected —'}
                        </span>
                      </div>
                      <span>▾</span>
                    </button>
                    {open && (
                      <div className="dropdown-menu" style={{
                        position:'absolute', zIndex:20, marginTop:6, width:'100%',
                        background:'#0e1420', border:'1px solid #1b2430', borderRadius:10, maxHeight:320, overflowY:'auto', boxShadow:'0 10px 30px rgba(0,0,0,0.35)'
                      }}>
                        {(!loadingTokens && detected.length === 0) && (
                          <div className="muted" style={{padding:12}}>— none detected —</div>
                        )}
                        {detected.map((t, i) => (
                          <div
                            key={t.address}
                            className="dropdown-item"
                            style={{display:'flex', alignItems:'center', gap:10, padding:'10px 12px', cursor:'pointer'}}
                            onClick={() => { setSelectedIdx(i); setOpen(false); }}
                          >
                            {t.logo && <img src={t.logo} alt="" width="20" height="20" style={{borderRadius:4}} />}
                            <div style={{display:'flex', flexDirection:'column', minWidth:0}}>
                              <div style={{display:'flex', alignItems:'center', gap:8, minWidth:0}}>
                                <span style={{fontWeight:600}}>{t.symbol || 'TOK'}</span>
                                <span className="muted mono" style={{fontSize:12, whiteSpace:'nowrap'}}>
                                  {t.address.slice(0,6)}…{t.address.slice(-4)}
                                </span>
                              </div>
                              <div className="muted" style={{fontSize:12, whiteSpace:'nowrap'}}>
                                {formatUnits(t.balanceRaw, Number.isFinite(t.decimals)?t.decimals:18)} {t.symbol || 'TOK'}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="row" style={{gap:10, flex: '1 1 220px'}}>
                  <button className="btn btn-ghost" onClick={()=> (account || address) && loadTokensFor(account || address)} disabled={!(account || address) || loadingTokens}>Reload tokens</button>
                  <label className="muted" style={{display:'flex', alignItems:'center', gap:6}}>
                    <input type="checkbox" checked={includeZero} onChange={e=>setIncludeZero(e.target.checked)} />
                    Include zero
                  </label>
                </div>
              </>
            )}

            {tokenMode === 'custom' && (
              <div style={{flex: '2 1 360px'}}>
                <label>Token address</label>
                <input placeholder="0x…" value={tokenAddr} onChange={e=>setTokenAddr(e.target.value.trim())} />
              </div>
            )}
          </div>

          {lastErr && (
            <div className="muted" style={{marginTop:8, fontSize:12}}>
              Note: {String(lastErr).slice(0,260)}{String(lastErr).length>260?'…':''}
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
              disabled={
                !isConnected || pending ||
                (tokenMode==='dropdown' && (selectedIdx<0 || !detected[selectedIdx])) ||
                (tokenMode==='custom' && (!tokenAddr || tokenAddr.length!==42)) ||
                !amount
              }
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
