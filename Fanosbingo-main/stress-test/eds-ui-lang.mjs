import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.UI_BASE || 'http://localhost:5174';
const OUT = 'C:/Users/zekio/AppData/Local/Temp';
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const errs = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const p = await b.newPage();
await p.setViewport({ width: 430, height: 920 });
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
const txt = async () => (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').trim();
const tap = async (rx) => {
  const h = await p.evaluateHandle(
    (r) => [...document.querySelectorAll('button,a')].find((x) => new RegExp(r, 'i').test(x.textContent)),
    rx.source,
  );
  const el = h.asElement();
  if (!el) throw new Error('no clickable element matching ' + rx);
  await el.click();
};
const ready = async (max = 40000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < max) {
    const t = await txt();
    if (t && !/Loading|በመጫን|fe.?aa jira|Could not/i.test(t) && (await p.$$('button')).length >= 5) return;
    await wait(500);
  }
  throw new Error('app never left splash: ' + (await txt()).slice(0, 120));
};
// bottom-nav buttons by DOM order: 0 Home, 1 Bingo, 2 Cartelas, 3 Wallet, 4 Profile
const nav = async (i) => {
  const all = await p.$$('button');
  const navBtns = all.slice(-5);
  await navBtns[i].click();
};

await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await ready();
console.log('1. HOME (default):', (await txt()).slice(0, 140));
await p.screenshot({ path: `${OUT}/lang-1-home-default.png` });

const gotoSettings = async () => {
  await nav(4); // Profile
  await wait(1200);
  // Settings is the first card button on the profile screen
  await tap(/setting|ቅንብ|qindaa|Qindaa/i);
  await wait(1000);
};

await gotoSettings();
await p.screenshot({ path: `${OUT}/lang-2-settings.png` });
console.log('2. SETTINGS:', (await txt()).slice(0, 140));

// open language list -> English
await tap(/language|ቋንቋ|afaan/i);
await wait(700);
await tap(/English/);
await wait(1600);
await nav(0);
await wait(1000);
const home_en = await txt();
console.log('3. HOME (English):', home_en.slice(0, 140));
await p.screenshot({ path: `${OUT}/lang-3-home-en.png` });

// -> Afaan Oromoo
await gotoSettings();
await tap(/language/i);
await wait(700);
await tap(/Afaan Oromoo/);
await wait(1600);
await nav(0);
await wait(1000);
const home_om = await txt();
console.log('4. HOME (Afaan Oromoo):', home_om.slice(0, 140));
await p.screenshot({ path: `${OUT}/lang-4-home-om.png` });

// persistence across a full reload
await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await ready();
await wait(800);
const home_reload = await txt();
console.log('5. HOME (after full reload):', home_reload.slice(0, 140));
await p.screenshot({ path: `${OUT}/lang-5-home-reload.png` });

// back to Amharic (leave a clean default)
await gotoSettings();
await tap(/language|afaan/i);
await wait(700);
await tap(/አማርኛ/);
await wait(1500);

console.log('\nEN differs from OM:', home_en !== home_om);
console.log('OM persisted across reload:', home_reload === home_om);
console.log('JS errors:', errs.length ? JSON.stringify([...new Set(errs)], null, 1) : 'none');
await b.close();
