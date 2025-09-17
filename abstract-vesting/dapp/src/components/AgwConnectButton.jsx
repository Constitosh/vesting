// src/components/AgwConnectButton.jsx
import React, { useState } from 'react';
import { useAccount, useBalance } from 'wagmi';
import { useLoginWithAbstract } from '@abstract-foundation/agw-react';

export default function AgwConnectButton({ onConnected, onDisconnected }) {
  const { isConnected, status, address } = useAccount();
  const { data: balance, isLoading: isBalanceLoading } = useBalance({ address });
  const { login, logout } = useLoginWithAbstract();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const fmtBal = balance ? `${parseFloat(balance.formatted).toFixed(4)} ${balance.symbol}` : '0.0000 ETH';
  const connecting = status === 'connecting' || status === 'reconnecting';

  const doLogin = async () => {
    await login();
    onConnected?.();
  };

  const doLogout = async () => {
    setMenuOpen(false);
    try { await logout(); } catch {}
    onDisconnected?.();
  };

  const copyAddr = async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Button styles (minimal; matches your CI vibe)
  const btn = "btn btn-accent";
  const chip = "btn btn-ghost";

  if (connecting) {
    return <button className={btn} disabled>Connecting… <AgwLogo className="ml-2" /></button>;
  }
  if (!isConnected) {
    return <button className={btn} onClick={doLogin}>Connect Abstract Wallet <AgwLogo className="ml-2" /></button>;
  }
  if (isConnected && isBalanceLoading) {
    return <button className={chip} disabled>Loading… <AgwLogo className="ml-2" /></button>;
  }

  return (
    <div className="dropdown" style={{ position:'relative' }}>
      <button className={chip} onClick={()=>setMenuOpen(v=>!v)}>
        {fmtBal} <AgwLogo className="ml-2" />
      </button>
      {menuOpen && (
        <div className="dropdown-menu card" style={{ position:'absolute', right:0, top:'110%', minWidth:220, zIndex:20 }}>
          <div className="row" style={{justifyContent:'space-between', alignItems:'center'}}>
            <span className="mono muted">
              {address ? `${address.slice(0,6)}…${address.slice(-4)}` : 'Connected'}
            </span>
            <button className="btn btn-ghost" style={{padding:'2px 6px'}} onClick={copyAddr}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="hr" />
          <button className="btn btn-ghost" onClick={doLogout} style={{color:'#ff6464'}}>Disconnect</button>
        </div>
      )}
    </div>
  );
}

function AgwLogo({ className }) {
  return (
    <svg width="18" height="16" viewBox="0 0 52 47" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M33.7221 31.0658L43.997 41.3463L39.1759 46.17L28.901 35.8895C28.0201 35.0081 26.8589 34.5273 25.6095 34.5273C24.3602 34.5273 23.199 35.0081 22.3181 35.8895L12.0432 46.17L7.22205 41.3463L17.4969 31.0658H33.7141H33.7221Z" />
      <path d="M35.4359 28.101L49.4668 31.8591L51.2287 25.2645L37.1978 21.5065C35.9965 21.186 34.9954 20.4167 34.3708 19.335C33.7461 18.2613 33.586 17.0033 33.9063 15.8013L37.6623 1.76283L31.0713 0L27.3153 14.0385L35.4279 28.093L35.4359 28.101Z" />
      <path d="M15.7912 28.101L1.76028 31.8591L-0.00158691 25.2645L14.0293 21.5065C15.2306 21.186 16.2316 20.4167 16.8563 19.335C17.4809 18.2613 17.6411 17.0033 17.3208 15.8013L13.5648 1.76283L20.1558 0L23.9118 14.0385L15.7992 28.093L15.7912 28.101Z" />
    </svg>
  );
}
