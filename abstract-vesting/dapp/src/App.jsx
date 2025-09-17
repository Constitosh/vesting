import React, { useEffect, useMemo, useRef, useState } from 'react';
import abi from './abi/VestiLock.abi.json';
import AgwConnectButton from './components/AgwConnectButton.jsx';

import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import {
  parseUnits as viemParseUnits,
  formatUnits as viemFormatUnits,
  getAddress,
} from 'viem';

// OPTIONAL fallback (desktop injectors); not used on mobile AGW
import { BrowserProvider, Contract as EthersContract, parseUnits as ethersParseUnits } from 'ethers';

/* =========================
   CONFIG
   ========================= */
const CHAIN_ID = 2741; // Abstract mainnet
const DURATIONS = [30,60,90,120,180,210,240,270,300,330,360];
const FIXED_FEE_ETH = '0.015';
const CONTRACT_ADDRESS = import.meta.env.VITE_VESTI_ADDRESS || '0xYourDeployedContract';
const ALCHEMY_URL = import.meta.env.VITE_ALCHEMY_URL || 'https://abstract-mainnet.g.alchemy.com/v2/M2JFR2r4147ajgncDt4xV';
const RPC_URL = 'https://api.mainnet.abs.xyz';

// minimal ERC20 abi
const ERC20_ABI = [
  { type:'function', name:'decimals', stateMutability:'view', inputs:[], outputs:[{type:'uint8'}] },
  { type:'function', name:'symbol', stateMutability:'view', inputs:[], outputs:[{type:'string'}] },
  { type:'function', name:'allowance', stateMutability:'view', inputs:[{type:'address',name:'owner'},{type:'address',name:'spender'}], outputs:[{type:'uint256'}] },
  { type:'function', name:'approve', stateMutability:'nonpayable', inputs:[{type:'address',name:'spender'},{type:'uint256',name:'value'}], outputs:[{type:'bool'}] },
];

function hexToBigIntSafe(h){ try{ return (!h||h==='0x')?0n:BigInt(h); }catch{ return 0n; } }
function useIsNarrow(bp=920){
  const [n,setN]=useState(()=>typeof window!=='undefined' ? window.innerWidth<bp : false);
  useEffect(()=>{ const r=()=>setN(window.innerWidth<bp); window.addEventListener('resize',r); return ()=>window.removeEventListener('resize',r);},[bp]);
  return n;
}
async function mapLimit(arr,limit,fn){
  const out=new Array(arr.length); let i=0;
  const workers=Array(Math.min(limit,arr.length)).fill(0).map(async()=>{ for(;;){ const idx=i++; if(idx>=arr.length)break; out[idx]=await fn(arr[idx],idx);} });
  await Promise.all(workers); return out;
}

// very light injection fallback (desktop only)
function getInjected(){
  if (typeof window==='undefined') return null;
  return window.abstract?.ethereum || window.agw?.ethereum || window.abstractWallet?.provider || window.ethereum || null;
}

export default function App(){
  const isNarrow = useIsNarrow();

  // AGW session (wagmi/viem)
  const { address: wagmiAddr, isConnected } = useAccount();
  const publicClient = usePublicClient(); // for reads (allowance, etc.)
  const { data: walletClient } = useWalletClient(); // for writes (sign/send)

  // Local provider (for log reads & graceful fallback to ethers if needed)
  const [ethersProvider, setEthersProvider] = useState(null);

  // UI/form state
  const [positions, setPositions] = useState([]);
  const [pending, setPending] = useState(false);
  const [confirmModal, setConfirmModal] = useState(false);

  const [tokenMode, setTokenMode] = useState('dropdown'); // dropdown | custom
  const [tokenAddr, setTokenAddr] = useState('');
  const [decimals, setDecimals] = useState(18);
  const [symbol, setSymbol] = useState('TOK');
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState(30);

  const [detected, setDetected] = useState([]); // [{address,balanceRaw,decimals,symbol,name?,logo?}]
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [includeZero, setIncludeZero] = useState(false);
  const [lastErr, setLastErr] = useState(null);

  // ethers provider for cheap log reads
  useEffect(() => {
    const inj = getInjected();
    if (inj) setEthersProvider(new BrowserProvider(inj));
    else setEthersProvider(new BrowserProvider({ // fallback RPC (read only)
      request: async ({method, params}) => fetch(RPC_URL,{
        method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})
      }).then(r=>r.json()).then(r=>r.result)
    }));
  },[]);

  // ---- Alchemy + DexScreener token list ----
  async function loadTokensFor(addr){
    setLoadingTokens(true); setLastErr(null);
    try{
      const body = { id:1, jsonrpc:'2.0', method:'alchemy_getTokenBalances', params:[addr,'erc20'] };
      const res = await fetch(ALCHEMY_URL, { method:'POST', mode:'cors', headers:{'accept':'application/json','content-type':'application/json'}, body:JSON.stringify(body) });
      const js = await res.json();
      const rows = Array.isArray(js?.result?.tokenBalances) ? js.result.tokenBalances : [];

      const base = rows.map(r=>({ address:r.contractAddress, balanceRaw:hexToBigIntSafe(r.tokenBalance||'0x0') }))
                       .filter(t=> includeZero ? true : t.balanceRaw>0n)
                       .slice(0,150);

      if(base.length===0){ setDetected([]); setSelectedIdx(-1); return; }

      const metaAlchemy = async (ca)=>{
        const b={id:1,jsonrpc:'2.0',method:'alchemy_getTokenMetadata',params:[ca]};
        const r=await fetch(ALCHEMY_URL,{method:'POST',mode:'cors',headers:{'accept':'application/json','content-type':'application/json'},body:JSON.stringify(b)});
        const j=await r.json(); const m=j?.result||{};
        return { symbol:(m.symbol||'TOK'), decimals:Number.isFinite(m.decimals)?Number(m.decimals):18, name:m.name||null, logo:m.logo||null };
      };
      const metaDex = async (ca)=>{
        const r=await fetch(`https://api.dexscreener.com/tokens/v1/abstract/${ca}`,{mode:'cors'});
        if(!r.ok) return null; const arr=await r.json(); const first=Array.isArray(arr)&&arr.length?arr[0]:null;
        if(!first) return null; const base=first.baseToken||{}; const info=first.info||{};
        return { symbol:base.symbol||null, name:base.name||null, logo:info.imageUrl||null };
      };

      const enriched = await mapLimit(base,8,async t=>{
        let dex=null, al=null;
        try{ dex=await metaDex(t.address);}catch{}
        try{ al=await metaAlchemy(t.address);}catch{}
        const symbol = dex?.symbol || al?.symbol || 'TOK';
        const name = dex?.name   || al?.name   || null;
        const logo = dex?.logo   || al?.logo   || null;
        const decimals = Number.isFinite(al?.decimals)?al.decimals:18;
        return { ...t, symbol, name, logo, decimals };
      });

      enriched.sort((a,b)=> (b.balanceRaw>a.balanceRaw?1:-1));
      setDetected(enriched);
      if(enriched.length){
        setTokenMode('dropdown'); setSelectedIdx(0);
        setTokenAddr(enriched[0].address);
        setSymbol(enriched[0].symbol||'TOK');
        setDecimals(Number.isFinite(enriched[0].decimals)?enriched[0].decimals:18);
      } else { setSelectedIdx(-1); }
    }catch(e){
      setLastErr(e?.message||String(e));
      setDetected([]); setSelectedIdx(-1);
    }finally{ setLoadingTokens(false); }
  }

  useEffect(()=>{
    const addr = wagmiAddr;
    if(!addr){ setDetected([]); setSelectedIdx(-1); return; }
    loadTokensFor(addr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[wagmiAddr, includeZero, ALCHEMY_URL]);

  useEffect(()=>{
    if(tokenMode!=='dropdown') return;
    if(selectedIdx<0 || !detected[selectedIdx]) return;
    const t=detected[selectedIdx];
    setTokenAddr(t.address);
    setSymbol(t.symbol||'TOK');
    setDecimals(Number.isFinite(t.decimals)?t.decimals:18);
  },[tokenMode, selectedIdx, detected]);

  // ---- Positions (read-only) ----
  const vestReadEthers = useMemo(()=>{
    if(!ethersProvider) return null;
    return new EthersContract(CONTRACT_ADDRESS, abi, ethersProvider);
  },[ethersProvider]);

  useEffect(()=>{
    (async ()=>{
      if(!vestReadEthers || !wagmiAddr) return;
      try{
        const filter = vestReadEthers.filters?.Deposit?.(null, wagmiAddr) || { address: CONTRACT_ADDRESS, topics: [] };
        const logs = await vestReadEthers.queryFilter(filter, -50000, 'latest');
        const items = await Promise.all(logs.slice(-20).map(async (l)=>{
          const id = l.args.id.toString();
          const pos = await vestReadEthers.getPosition(id);
          return { id, token: pos.token, amount: pos.amount, unlockAt: Number(pos.unlockAt) };
        }));
        setPositions(items.reverse());
      }catch{}
    })();
  },[vestReadEthers, wagmiAddr]);

  // ---- Actions via viem walletClient (preferred) or injected ethers (fallback) ----

  async function approveIfNeeded_v(erc20, owner, spender, amount){
    const allowance = await publicClient.readContract({ address: erc20, abi: ERC20_ABI, functionName: 'allowance', args:[owner, spender] });
    if (allowance >= amount) return;
    await walletClient.writeContract({ address: erc20, abi: ERC20_ABI, functionName: 'approve', args:[spender, amount] });
  }

  async function lock_v(){
    if(!walletClient || !publicClient) throw new Error('Wallet session not ready. Tap Connect first.');
    if(!wagmiAddr) throw new Error('No wallet address.');
    const ca = getAddress(tokenAddr);
    const amt = viemParseUnits(String(amount||'0'), decimals);
    await approveIfNeeded_v(ca, wagmiAddr, getAddress(CONTRACT_ADDRESS), amt);
    await walletClient.writeContract({
      address: getAddress(CONTRACT_ADDRESS),
      abi,
      functionName: 'lock',
      args: [ ca, amt, Number(days) ],
      value: viemParseUnits(FIXED_FEE_ETH, 18),
      chain: { id: CHAIN_ID, name:'Abstract', nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18}, rpcUrls:{default:{http:[RPC_URL]}} },
      account: wagmiAddr,
    });
  }

  async function withdraw_v(id){
    if(!walletClient) throw new Error('Wallet session not ready.');
    await walletClient.writeContract({
      address: getAddress(CONTRACT_ADDRESS),
      abi,
      functionName: 'withdraw',
      args: [ BigInt(id) ],
      chain: { id: CHAIN_ID, name:'Abstract', nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18}, rpcUrls:{default:{http:[RPC_URL]}} },
      account: wagmiAddr,
    });
  }

  // desktop fallback (if walletClient is missing but an injected provider exists)
  async function lock_fallback(){
    const injected = getInjected();
    if(!injected) throw new Error('No injected wallet provider found.');
    const bp = new BrowserProvider(injected);
    const signer = await bp.getSigner();
    const owner = await signer.getAddress();
    const ca = tokenAddr;
    const amt = ethersParseUnits(String(amount||'0'), decimals);
    const erc20 = new EthersContract(ca, ERC20_ABI, signer);
    const allowance = await erc20.allowance(owner, CONTRACT_ADDRESS);
    if(allowance < amt){
      const aTx = await erc20.approve(CONTRACT_ADDRESS, amt); await aTx.wait();
    }
    const vestW = new EthersContract(CONTRACT_ADDRESS, abi, signer);
    const tx = await vestW.lock(ca, amt, days, { value: ethersParseUnits(FIXED_FEE_ETH,18) });
    await tx.wait();
  }

  async function withdraw_fallback(id){
    const injected = getInjected();
    if(!injected) throw new Error('No injected wallet provider found.');
    const bp = new BrowserProvider(injected);
    const signer = await bp.getSigner();
    const vestW = new EthersContract(CONTRACT_ADDRESS, abi, signer);
    const tx = await vestW.withdraw(id);
    await tx.wait();
  }

  const onLock = async ()=>{
    if(!isConnected) return alert('Tap Connect first.');
    if(!tokenAddr || tokenAddr.length!==42) return alert('Choose a token.');
    if(!amount || Number(amount)<=0) return alert('Enter an amount.');
    setPending(true);
    try{
      if (walletClient) {
        await lock_v();
      } else {
        await lock_fallback();
      }
      setConfirmModal(false);
    }catch(e){
      alert(e?.shortMessage || e?.message || 'Transaction failed');
    }finally{ setPending(false); }
  };

  const onWithdraw = async (id)=>{
    setPending(true);
    try{
      if (walletClient) await withdraw_v(id);
      else await withdraw_fallback(id);
      setPositions(p=>p.filter(x=>x.id!==id));
    }catch(e){
      alert(e?.shortMessage || e?.message || 'Withdraw failed');
    }finally{ setPending(false); }
  };

  // ----- UI helpers -----
  const now = Math.floor(Date.now()/1000);
  const gridStyle = isNarrow
    ? { display:'grid', gridTemplateColumns:'1fr', gap:20 }
    : { display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 };

  const [open, setOpen] = useState(false);
  const dropdownRef = useRef(null);
  useEffect(()=>{
    const onClick=e=>{ if(!dropdownRef.current) return; if(!dropdownRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('click', onClick); return ()=>document.removeEventListener('click', onClick);
  },[]);
  const selected = (tokenMode==='dropdown' && selectedIdx>=0) ? detected[selectedIdx] : null;

  return (
    <div className="shell">
      {/* NAV */}
      <div className="nav">
        <div className="brand">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#62f3a7" strokeWidth="2"/><path d="M7 13l3 3 7-7" stroke="#62f3a7" strokeWidth="2"/></svg>
        {/* brand */}
          <span>The tABS VestiLock</span>
          <span className="pill">Abstract · Mainnet</span>
        </div>
        <AgwConnectButton />
      </div>

      {/* Status */}
      <div className="muted" style={{margin:'4px 4px 12px'}}>
        acct: { wagmiAddr ? `${wagmiAddr.slice(0,6)}…${wagmiAddr.slice(-4)}` : '—' } · chain: 0xab5
      </div>

      {/* MAIN */}
      <div style={gridStyle}>
        <div className="card">
          <h2>Lock Tokens</h2>
          <p className="muted">Lock ERC-20 tokens for a fixed time. Only the depositing wallet can withdraw after unlock.</p>
          <div className="hr" />

          <div className="row" style={{gap:12, alignItems:'end', flexWrap:'wrap'}}>
            <div style={{flex:'1 1 180px'}}>
              <label>Token source</label>
              <select value={tokenMode} onChange={e=>setTokenMode(e.target.value)}>
                <option value="dropdown">My wallet tokens (Alchemy)</option>
                <option value="custom">Custom token address…</option>
              </select>
            </div>

            {tokenMode==='dropdown' && (
              <>
                <div style={{flex:'2 1 360px'}} ref={dropdownRef}>
                  <label>Choose token {loadingTokens && <span className="muted">(loading…)</span>}</label>
                  <div className="dropdown">
                    <button className="btn btn-ghost" style={{width:'100%', justifyContent:'space-between'}} onClick={()=>setOpen(v=>!v)}>
                      <div style={{display:'flex', alignItems:'center', gap:8, overflow:'hidden'}}>
                        {selected?.logo && <img src={selected.logo} width="20" height="20" style={{borderRadius:4}} alt="" />}
                        <span className="mono" style={{whiteSpace:'nowrap', textOverflow:'ellipsis', overflow:'hidden'}}>
                          {selected ? `${selected.symbol || 'TOK'} — ${selected.address.slice(0,6)}…${selected.address.slice(-4)}` : '— none detected —'}
                        </span>
                      </div>
                      <span>▾</span>
                    </button>
                    {open && (
                      <div className="dropdown-menu" style={{ position:'absolute', zIndex:20, marginTop:6, width:'100%', background:'#0e1420', border:'1px solid #1b2430', borderRadius:10, maxHeight:320, overflowY:'auto', boxShadow:'0 10px 30px rgba(0,0,0,0.35)'}}>
                        {(!loadingTokens && detected.length===0) && <div className="muted" style={{padding:12}}>— none detected —</div>}
                        {detected.map((t,i)=>(
                          <div key={t.address} className="dropdown-item" style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',cursor:'pointer'}} onClick={()=>{ setSelectedIdx(i); setOpen(false); }}>
                            {t.logo && <img src={t.logo} width="20" height="20" style={{borderRadius:4}} alt="" />}
                            <div style={{display:'flex',flexDirection:'column',minWidth:0}}>
                              <div style={{display:'flex',alignItems:'center',gap:8,minWidth:0}}>
                                <span style={{fontWeight:600}}>{t.symbol||'TOK'}</span>
                                <span className="muted mono" style={{fontSize:12,whiteSpace:'nowrap'}}>{t.address.slice(0,6)}…{t.address.slice(-4)}</span>
                              </div>
                              <div className="muted" style={{fontSize:12,whiteSpace:'nowrap'}}>
                                {viemFormatUnits(t.balanceRaw, Number.isFinite(t.decimals)?t.decimals:18)} {t.symbol||'TOK'}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="row" style={{gap:10, flex:'1 1 220px'}}>
                  <button className="btn btn-ghost" onClick={()=> wagmiAddr && loadTokensFor(wagmiAddr)} disabled={!wagmiAddr || loadingTokens}>Reload tokens</button>
                  <label className="muted" style={{display:'flex',alignItems:'center',gap:6}}>
                    <input type="checkbox" checked={includeZero} onChange={e=>setIncludeZero(e.target.checked)} />
                    Include zero
                  </label>
                </div>
              </>
            )}

            {tokenMode==='custom' && (
              <div style={{flex:'2 1 360px'}}>
                <label>Token address</label>
                <input placeholder="0x…" value={tokenAddr} onChange={e=>setTokenAddr(e.target.value.trim())} />
              </div>
            )}
          </div>

          {lastErr && <div className="muted" style={{marginTop:8,fontSize:12}}>Note: {String(lastErr).slice(0,260)}{String(lastErr).length>260?'…':''}</div>}

          <div className="row" style={{gap:12, marginTop:12, flexWrap:'wrap'}}>
            <div style={{flex:'1 1 200px'}}>
              <label>Amount ({symbol})</label>
              <input type="number" min="0" step="any" value={amount} onChange={e=>setAmount(e.target.value)} />
            </div>
            <div style={{flex:'1 1 200px'}}>
              <label>Duration (days)</label>
              <select value={days} onChange={e=>setDays(Number(e.target.value))}>
                {DURATIONS.map(d=><option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>

          <div className="warn" style={{marginTop:12}}>
            <strong>Heads-up:</strong> Include <span className="mono">{FIXED_FEE_ETH} ETH</span> with the lock tx.
            Funds are escrowed; only the same wallet can withdraw. If you lose keys, funds are <strong>lost</strong>.
          </div>

          <div style={{display:'flex',gap:10,marginTop:12}}>
            <button
              className="btn btn-ghost"
              onClick={()=>setConfirmModal(true)}
              disabled={!isConnected || pending ||
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
          {!wagmiAddr && <div className="muted">Not connected.</div>}
          {(wagmiAddr && positions.length===0) && <div className="muted">No recent positions found.</div>}
          {positions.map(p=>{
            const left = Math.max(0, p.unlockAt - now);
            const ready = left===0;
            return (
              <div key={p.id} style={{marginBottom:12,paddingBottom:12,borderBottom:'1px solid #1b2430'}}>
                <div className="row" style={{justifyContent:'space-between',flexWrap:'wrap',gap:8}}>
                  <div>
                    <div className="mono">ID #{p.id}</div>
                    <div className="muted">Unlock {new Date(p.unlockAt*1000).toLocaleString()}</div>
                  </div>
                  <div className="row" style={{gap:6}}>
                    <span className="pill">{viemFormatUnits(p.amount, decimals)} {symbol}</span>
                    {ready ? <span className="pill" style={{borderColor:'#27423a',background:'#0f1d18',color:'#8ff3b6'}}>Ready</span>
                           : <span className="pill">{Math.ceil(left/86400)}d left</span>}
                  </div>
                </div>
                <div style={{marginTop:8}}>
                  <button className="btn btn-accent" disabled={!ready || pending} onClick={()=>onWithdraw(p.id)}>Withdraw</button>
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
            <div className="row" style={{justifyContent:'flex-end',marginTop:12}}>
              <button className="btn btn-ghost" disabled={pending} onClick={()=>setConfirmModal(false)}>Cancel</button>
              <button className="btn btn-accent" disabled={pending} onClick={async ()=>{
                setPending(true);
                try{
                  if (walletClient) await lock_v();
                  else await lock_fallback(); // desktop/MM fallback only
                  setConfirmModal(false);
                }catch(e){ alert(e?.shortMessage || e?.message || 'Transaction failed'); }
                finally{ setPending(false); }
              }}>{pending?'Working…':'I Understand, Lock Now'}</button>
            </div>
          </div>
        </div>
      )}

      <div style={{marginTop:24}} className="muted">
        <div>Network: Abstract (chainId 2741). Explorer: <a href="https://abscan.org/" target="_blank">abscan.org</a></div>
      </div>
    </div>
  );
}