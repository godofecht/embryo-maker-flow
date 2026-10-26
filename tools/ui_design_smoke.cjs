const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const url = process.env.EMBRYOMAKER_URL || 'http://127.0.0.1:8765';
(async () => {
  const browser = await chromium.launch({ headless: true, args: process.env.UI_SMOKE_SINGLE_PROCESS === '1' ? ['--single-process', '--no-zygote'] : [] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#status .message').textContent.includes('Model ready'));
    assert(await page.locator('.left-panel').isVisible());
    await page.locator('#stepBtn').click();
    await page.waitForFunction(() => document.querySelector('#iterationValue').textContent === '1');
    await page.locator('#runBtn').click();
    await page.waitForFunction(() => Number(document.querySelector('#iterationValue').textContent) > 1);
    await page.locator('#pauseBtn').click();
    await page.waitForFunction(() => document.querySelector('#timelinePlay').getAttribute('aria-pressed') === 'false');
    await page.locator('#resetBtn').click();
    await page.waitForFunction(() => document.querySelector('#iterationValue').textContent === '0');
    await page.locator('#cacheBadge').focus();
    await page.keyboard.press('Enter');
    assert(await page.locator('#cacheModal').isVisible());
    assert(await page.locator('#cacheModal').evaluate(el => el.contains(document.activeElement)));
    await page.keyboard.press('Shift+Tab');
    assert(await page.locator('#cacheModal').evaluate(el => el.contains(document.activeElement)));
    await page.keyboard.press('Escape');
    assert(await page.locator('#cacheBadge').evaluate(el => el === document.activeElement));
    fs.mkdirSync('build/ui-design', { recursive: true });
    for (const [width, height] of [[1440,1000],[1024,768],[390,844]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await page.evaluate(() => {
        const canvas = document.querySelector('#stage').getBoundingClientRect();
        return { width: canvas.width, height: canvas.height, right: canvas.right, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert(!geometry.overflow, JSON.stringify({width,geometry}));
      const clipped=await page.locator('.topbar button').evaluateAll(buttons=>buttons.filter(b=>b.getClientRects().length&&b.getBoundingClientRect().right>innerWidth+1).map(b=>b.id));
      assert.deepEqual(clipped,[],`Clipped toolbar at ${width}px`);
      assert(geometry.width > 0 && geometry.height > 0 && geometry.right <= width + 1,JSON.stringify({width,geometry}));
      assert(Math.abs(geometry.width / geometry.height - 1) < .1, JSON.stringify(geometry));
      await page.screenshot({ path: `build/ui-design/studio-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({width:1440,height:700});
    const panel=page.locator('.left-panel');
    await panel.hover();
    await page.mouse.wheel(0,500);
    await page.waitForFunction(() => document.querySelector('.left-panel').scrollTop > 0);
    assert.equal(await page.evaluate(() => scrollY),0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.deepEqual(errors,[]);
    console.log('PASS: transport, dialog focus, responsive geometry, panel scrolling, clean runtime logs');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
