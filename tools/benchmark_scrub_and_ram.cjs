const { chromium } = require('playwright');

async function benchmark() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  console.log('1. Loading EmbryoMaker Studio…');
  await page.goto('http://127.0.0.1:8765');
  await page.waitForFunction(() => document.querySelector('#status .message')?.textContent.startsWith('Model ready at iteration 0'));

  console.log('2. Running 60 steps to generate trajectory cache…');
  for (let i = 1; i <= 60; i++) {
    await page.evaluate(() => document.querySelector('#stepBtn').click());
    await page.waitForFunction(target => Number(document.querySelector('#iterationValue')?.textContent) === target, i);
  }

  const cacheStatus = await page.evaluate(() => ({
    totalFrames: state.trajectoryFrames.size,
    ramFrames: state.trajectoryFrames.ramCache.size,
    sortedCount: state.trajectoryFrames.sortedIters.length,
    maxRamLimit: state.trajectoryFrames.MAX_RAM_FRAMES
  }));
  console.log('Cache status after 60 steps:', JSON.stringify(cacheStatus));

  if (cacheStatus.ramFrames > cacheStatus.maxRamLimit) {
    throw new Error(`RAM cache limit violated: ${cacheStatus.ramFrames} > ${cacheStatus.maxRamLimit}`);
  }

  console.log('3. Benchmarking 100 rapid scrub events (measuring latency and FPS)…');
  const scrubResults = await page.evaluate(async () => {
    const range = document.querySelector('#iterationRange');
    const timestamps = [];
    const iterations = [];

    for (let cycle = 0; cycle < 5; cycle++) {
      // Scrub forward
      for (let i = 0; i <= 60; i += 3) {
        const t0 = performance.now();
        range.value = i;
        range.dispatchEvent(new Event('input'));
        const t1 = performance.now();
        timestamps.push(t1 - t0);
        iterations.push(state.iteration);
      }
      // Scrub backward
      for (let i = 60; i >= 0; i -= 3) {
        const t0 = performance.now();
        range.value = i;
        range.dispatchEvent(new Event('input'));
        const t1 = performance.now();
        timestamps.push(t1 - t0);
        iterations.push(state.iteration);
      }
    }

    const avgMs = timestamps.reduce((a, b) => a + b, 0) / timestamps.length;
    const maxMs = Math.max(...timestamps);
    const minMs = Math.min(...timestamps);
    const theoreticalFps = 1000 / avgMs;

    return {
      scrubCount: timestamps.length,
      avgMs: Number(avgMs.toFixed(3)),
      minMs: Number(minMs.toFixed(3)),
      maxMs: Number(maxMs.toFixed(3)),
      theoreticalFps: Math.round(theoreticalFps),
      finalIteration: state.iteration,
      ramCacheSize: state.trajectoryFrames.ramCache.size
    };
  });

  console.log('Scrub benchmark results:', JSON.stringify(scrubResults, null, 2));

  if (scrubResults.avgMs > 5.0) {
    throw new Error(`Scrub latency too high: average ${scrubResults.avgMs} ms (expected < 5 ms)`);
  }

  if (scrubResults.ramCacheSize > 48) {
    throw new Error(`RAM cache grew beyond limit during scrub: ${scrubResults.ramCacheSize}`);
  }

  console.log('4. Testing precomputed Sea Urchin project loading…');
  await page.evaluate(() => document.querySelector('#loadPrecomputedBtn').click());
  await page.waitForFunction(() => state.trajectoryFrames.size > 0 && state.isTrajectoryMode, null, { timeout: 15000 });

  const seaUrchinStatus = await page.evaluate(() => ({
    totalFrames: state.trajectoryFrames.size,
    ramFrames: state.trajectoryFrames.ramCache.size,
    isTrajectoryMode: state.isTrajectoryMode,
    maxIter: state.max,
    minIter: state.minIteration,
    nodeCount: state.nodes.length
  }));
  console.log('Sea Urchin project loaded:', JSON.stringify(seaUrchinStatus));

  console.log('5. Scrubbing Sea Urchin precomputed project…');
  const urchinScrubResults = await page.evaluate(async () => {
    const range = document.querySelector('#iterationRange');
    const timestamps = [];
    const iters = state.trajectoryFrames.sortedIters;

    for (let step = 0; step < Math.min(20, iters.length); step++) {
      const target = iters[step];
      const t0 = performance.now();
      range.value = target;
      range.dispatchEvent(new Event('input'));
      const t1 = performance.now();
      timestamps.push(t1 - t0);
    }

    const avgMs = timestamps.reduce((a, b) => a + b, 0) / timestamps.length;
    return {
      avgMs: Number(avgMs.toFixed(3)),
      fps: Math.round(1000 / avgMs),
      ramFrames: state.trajectoryFrames.ramCache.size
    };
  });
  console.log('Sea Urchin scrub results:', JSON.stringify(urchinScrubResults, null, 2));

  if (errors.length) {
    throw new Error(`Browser console/runtime errors:\n${errors.join('\n')}`);
  }

  console.log('All performance and memory benchmarks PASSED with 0 errors.');
  await browser.close();
}

benchmark().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
