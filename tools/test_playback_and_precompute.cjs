const { chromium } = require('playwright');

async function testPlaybackAndPrecompute() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  console.log('1. Loading Studio…');
  await page.goto('http://127.0.0.1:8765');
  await page.waitForFunction(() => document.querySelector('#status .message')?.textContent.startsWith('Model ready at iteration 0'));

  console.log('2. Running 30 steps to seed the cache…');
  for (let i = 1; i <= 30; i++) {
    await page.evaluate(() => document.querySelector('#stepBtn').click());
    await page.waitForFunction(target => Number(document.querySelector('#iterationValue')?.textContent) === target, i);
  }

  const initialCached = await page.evaluate(() => ({
    total: state.trajectoryFrames.size,
    iteration: state.iteration
  }));
  console.log('Seeded cache:', JSON.stringify(initialCached));

  console.log('3. Rewinding slider to iteration 5…');
  await page.evaluate(() => {
    const range = document.querySelector('#iterationRange');
    range.value = 5;
    range.dispatchEvent(new Event('input'));
    range.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => state.iteration === 5);
  console.log('Rewound to iteration:', await page.evaluate(() => state.iteration));

  console.log('4. Hitting Play in "fast" mode to test smooth cached playback…');
  await page.evaluate(() => {
    document.querySelector('#speed').value = 'fast';
    document.querySelector('#timelinePlay').click();
  });

  // Watch it advance through the cached frames (5 -> 10 -> 20 -> 30)
  await page.waitForFunction(() => state.iteration >= 25, null, { timeout: 10000 });
  const midPlayback = await page.evaluate(() => ({
    iteration: state.iteration,
    playing: state.playing,
    rateText: state.rateText
  }));
  console.log('Mid-playback state (playing cached frames):', JSON.stringify(midPlayback));

  // Watch it seamlessly cross the boundary from cached into newly computed frames (> 30)
  await page.waitForFunction(() => state.iteration > 35, null, { timeout: 15000 });
  const computedState = await page.evaluate(() => ({
    iteration: state.iteration,
    playing: state.playing,
    rateText: state.rateText,
    totalCached: state.trajectoryFrames.size
  }));
  console.log('Crossed boundary into new computation:', JSON.stringify(computedState));

  // Pause
  await page.evaluate(() => {
    if (state.playing) document.querySelector('#timelinePlay').click();
  });
  await page.waitForFunction(() => !state.playing);
  await page.waitForFunction(() => !state.busy);
  console.log('Paused at iteration:', await page.evaluate(() => state.iteration));

  console.log('5. Testing Precompute Pending Range button…');
  await page.evaluate(() => document.querySelector('#fillUncalcBtn').click());

  await page.waitForFunction(() => {
    const status = document.querySelector('#status .message')?.textContent || '';
    return status.includes('Precomputation complete') || status.includes('All iterations in the current range') || state.iteration >= state.max;
  }, null, { timeout: 20000 });

  const finalCache = await page.evaluate(() => ({
    totalCached: state.trajectoryFrames.size,
    max: state.max,
    iteration: state.iteration,
    status: document.querySelector('#status .message')?.textContent
  }));
  console.log('Precomputation finished. Final cache:', JSON.stringify(finalCache));

  if (errors.length) {
    throw new Error(`Browser errors:\n${errors.join('\n')}`);
  }

  console.log('Playback, compute, and precompute tests all PASSED with 0 errors.');
  await browser.close();
}

testPlaybackAndPrecompute().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
