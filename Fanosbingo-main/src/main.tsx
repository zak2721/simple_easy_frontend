import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Preconnect to the backend API for a faster first load. Was previously an
// inline <script> in index.html; moved here so the CSP's script-src can be
// 'self' only, with no 'unsafe-inline' carve-out — this still runs before
// the app renders, just as an ordinary module-script statement instead.
try {
  const url = import.meta.env.VITE_API_BASE_URL;
  if (url && url.startsWith('http')) {
    const pre = document.createElement('link');
    pre.rel = 'preconnect';
    pre.href = url;
    pre.crossOrigin = '';
    document.head.appendChild(pre);
  }
} catch {
  /* best-effort only */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
