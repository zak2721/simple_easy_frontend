import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'C:/Users/zekio/AppData/Local/Temp';
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const errs = [];
const p = await b.newPage();
await p.setViewport({ width: 430, height: 940 });
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await p.goto('http://localhost:5173/', { waitUntil: 'networkidle2' });
await wait(2500);
// go to Bingo
await (await p.evaluateHandle(() => [...document.querySelectorAll('button')].find((x) => /^Bingo$/i.test(x.textContent.trim())))).click();
await wait(2500);

// click ETB5 cartela #7 and ETB10 cartela #3  (both room grids on the page)
const clicked = await p.evaluate(() => {
  const btns = [...document.querySelectorAll('button')];
  // room grids: buttons whose text is exactly a number
  const n7 = btns.filter((x) => x.textContent.trim() === '7');
  const n3 = btns.filter((x) => x.textContent.trim() === '3');
  n7[0]?.click();       // first grid = ETB5
  n3[1]?.click();       // second '3' = ETB10 grid
  return { n7: n7.length, n3: n3.length };
});
await wait(800);
await p.screenshot({ path: `${OUT}/ui-buy-selected.png` });

// confirm
const confirmed = await p.evaluate(() => {
  const c = [...document.querySelectorAll('button')].find((x) => /Confirm \d+ cartela/i.test(x.textContent));
  if (c) { c.click(); return c.textContent.trim(); }
  return null;
});
console.log('confirm button:', confirmed);
await wait(4000);
await p.screenshot({ path: `${OUT}/ui-buy-done.png` });
console.log('after buy:', (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 300));

// My Cartelas tab
await (await p.evaluateHandle(() => [...document.querySelectorAll('button')].find((x) => /Cartelas/i.test(x.textContent.trim())))).click();
await wait(2500);
await p.screenshot({ path: `${OUT}/ui-my-cartelas.png` });
console.log('MY CARTELAS:', (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 300));

console.log('JS errors:', errs.length ? JSON.stringify([...new Set(errs)]) : 'none');
await b.close();
