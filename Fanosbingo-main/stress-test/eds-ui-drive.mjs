import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:5173';
const OUT = 'C:/Users/zekio/AppData/Local/Temp';
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const errs = [];
const P = async (w, h) => { const p = await b.newPage(); await p.setViewport({ width: w, height: h }); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text())); return p; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tap = async (p, re) => { const h = await p.evaluateHandle((r) => [...document.querySelectorAll('button,a')].find((x) => new RegExp(r, 'i').test(x.textContent)), re.source); if (h) { await h.click(); } };

// ---- Mini App as Alice (dev user) ----
const m = await P(430, 920);
await m.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await wait(2500);
console.log('HOME text:', (await m.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 400));
await m.screenshot({ path: `${OUT}/ui-home.png` });

await tap(m, /Bingo/);
await wait(2500);
await m.screenshot({ path: `${OUT}/ui-bingo.png` });
console.log('BINGO text:', (await m.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 350));

await tap(m, /Wallet/);
await wait(2000);
await m.screenshot({ path: `${OUT}/ui-wallet.png` });
console.log('WALLET text:', (await m.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 350));

// ---- Admin dashboard (login) ----
const a = await P(1280, 900);
await a.goto(`${BASE}/admin`, { waitUntil: 'networkidle2' });
await wait(1000);
const ins = await a.$$('input');
await ins[0].type('owner');
await ins[1].type('ownerpass123');
await tap(a, /Sign in/);
await wait(3000);
await a.screenshot({ path: `${OUT}/ui-admin-dash.png` });
console.log('ADMIN text:', (await a.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 500));

await tap(a, /Deposits/);
await wait(2000);
await a.screenshot({ path: `${OUT}/ui-admin-deposits.png` });

console.log('JS errors:', errs.length ? JSON.stringify([...new Set(errs)], null, 1) : 'none');
await b.close();
