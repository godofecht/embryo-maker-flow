const fs = require('node:fs');
const net = require('node:net');
const { chromium } = require('playwright');

const baseUrl = process.env.EMBRYOMAKER_URL || 'http://127.0.0.1:8765';
const timeout = Number.parseInt(process.env.UI_SMOKE_TIMEOUT_MS || '90000', 10);

function progress(message) {
  if (process.env.UI_SMOKE_PROGRESS === '1') process.stderr.write(`[ui-smoke] ${message}\n`);
}

function withTimeout(promise, duration, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${duration} ms`)), duration); })
  ]).finally(() => clearTimeout(timer));
}

function apiUrl(path) {
  return new URL(path, baseUrl).toString();
}

async function rawHttpRequest(headers, body = '') {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(target.port || 80), target.hostname);
    let response = '';
    socket.setTimeout(timeout, () => socket.destroy(new Error('Raw HTTP smoke request timed out')));
    socket.on('connect', () => socket.write(`POST /api/session HTTP/1.1\r\nHost: ${target.host}\r\n${headers}\r\nConnection: close\r\n\r\n${body}`));
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

async function checkHttpFraming() {
  const body = '{"example":"missing"}';
  const length = Buffer.byteLength(body);
  const mixedCase = await rawHttpRequest(`cOnTeNt-LeNgTh: ${length}`, body);
  if (!mixedCase.startsWith('HTTP/1.1 400 ') || !mixedCase.includes('Unknown EmbryoMaker example')) {
    throw new Error('HTTP field names were not parsed case insensitively');
  }
  const duplicateLength = await rawHttpRequest(`Content-Length: ${length}\r\nCONTENT-LENGTH: ${length}`, body);
  if (!duplicateLength.startsWith('HTTP/1.1 400 ') || !duplicateLength.includes('Bad request')) {
    throw new Error('Duplicate Content-Length fields were not rejected');
  }
  const transferEncoding = await rawHttpRequest('Transfer-Encoding: chunked', '0\r\n\r\n');
  if (!transferEncoding.startsWith('HTTP/1.1 400 ') || !transferEncoding.includes('Bad request')) {
    throw new Error('Unsupported transfer encoding was not rejected');
  }
  return { mixedCaseContentLength: true, duplicateContentLengthRejected: true, transferEncodingRejected: true };
}

async function waitForStatus(page, predicate, description, argument = null) {
  progress(`waiting for status: ${description}`);
  try {
    await page.waitForFunction(predicate, argument, { timeout });
  } catch (error) {
    const diagnostics = await Promise.race([page.evaluate(() => ({
      status: document.querySelector('#status .message')?.textContent,
      iteration: document.querySelector('#iterationValue')?.textContent,
      runDisabled: document.querySelector('#runBtn')?.disabled,
      stepDisabled: document.querySelector('#stepBtn')?.disabled,
      pauseDisabled: document.querySelector('#pauseBtn')?.disabled,
      frame: window.embryomakerRenderer?.lastFrame
    })), new Promise(resolve => setTimeout(() => resolve({ pageUnresponsive: true }), 2500))]);
    const screenshotPath = `/tmp/embryomaker-smoke-${description.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
    await page.screenshot({ path: screenshotPath, timeout: 3000 }).catch(() => {});
    throw new Error(`${description} timed out with ${JSON.stringify(diagnostics)}; screenshot: ${screenshotPath}; ${error.message}`);
  }
  const status = await page.locator('#status .message').textContent();
  if (!status) throw new Error(`${description}: status text is empty`);
  progress(`finished status: ${description}`);
  return status;
}

async function waitForNextRender(page, previous, description) {
  progress(`waiting for render: ${description}`);
  try {
    await page.waitForFunction(serial => {
      const frame = window.embryomakerRenderer?.lastFrame;
      return frame?.serial > serial && frame.visibleNodes > 0 && frame.glError === 0;
    }, previous, { timeout, polling: 100 });
  } catch (error) {
    const diagnostics = await Promise.race([
      page.evaluate(() => ({
        status: document.querySelector('#status .message')?.textContent,
        frame: window.embryomakerRenderer?.lastFrame,
        runtimeErrors: window.__embryomakerRuntimeErrors
      })),
      new Promise(resolve => setTimeout(() => resolve({ pageUnresponsive: true }), 3000))
    ]);
    const screenshotPath = `/tmp/embryomaker-render-${description.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
    await page.screenshot({ path: screenshotPath, timeout: 5000 }).catch(() => {});
    throw new Error(`${description} did not render after frame ${previous}: ${JSON.stringify(diagnostics)}; screenshot: ${screenshotPath}; ${error.message}`);
  }
  progress(`finished render: ${description}`);
  return description;
}

async function readCurrentSnapshot(page) {
  return page.evaluate(async () => {
    const entry = performance.getEntriesByType('resource').reverse().find(item =>
      new URL(item.name).pathname.match(/^\/api\/session\/[^/]+\/advance$/)
    );
    if (!entry) throw new Error('Could not find the active simulation session URL');
    const response = await fetch(entry.name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: 0, includeSnapshot: true })
    });
    const data = await response.json();
    if (!response.ok || typeof data.snapshot !== 'string') throw new Error(`Snapshot request failed: ${JSON.stringify(data)}`);
    return data.snapshot;
  });
}

async function readCurrentModel(page) {
  return page.evaluate(async () => {
    const entry = performance.getEntriesByType('resource').reverse().find(item =>
      new URL(item.name).pathname.match(/^\/api\/session\/[^/]+\/advance$/)
    );
    if (!entry) throw new Error('Could not find the active simulation session URL');
    const response = await fetch(entry.name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: 0, includeSnapshot: false })
    });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.nodes)) throw new Error(`Model request failed: ${JSON.stringify(data)}`);
    return data;
  });
}

async function openOgMenu(page) {
  if (await page.locator('.classic-menu').isHidden()) {
    const bounds = await page.evaluate(() => {
      const rect = document.querySelector('#stage')?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    });
    if (!bounds) throw new Error('The visualization canvas has no clickable bounds');
    await page.mouse.click(bounds.x + 35, bounds.y + 45, { button: 'right' });
    await page.waitForFunction(() => !document.querySelector('.classic-menu')?.hidden, null, { timeout: Math.min(timeout, 5000) });
  }
}

async function openOgCategory(page, category) {
  await openOgMenu(page);
  const summary = page.locator('.classic-menu summary').filter({ hasText: category });
  if (!(await summary.evaluate(element => element.parentElement.open))) await summary.click();
}

async function openWhatToDraw(page) {
  await openOgMenu(page);
  const summary = page.locator('.classic-menu summary').filter({ hasText: 'What to draw' });
  if (!(await summary.evaluate(element => element.parentElement.open))) await summary.click();
}

async function openCameraMenu(page) {
  if (await page.locator('.classic-menu').isHidden()) {
    const bounds = await page.evaluate(() => {
      const rect = document.querySelector('#stage')?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    });
    if (!bounds) throw new Error('The visualization canvas has no clickable bounds');
    await page.mouse.click(bounds.x + 35, bounds.y + 45, { button: 'right' });
    await page.waitForFunction(() => !document.querySelector('.classic-menu')?.hidden, null, { timeout: Math.min(timeout, 5000) });
  }
  const basic = page.locator('.classic-menu > details').filter({ hasText: 'Basic View Modifier' });
  if (!(await basic.evaluate(element => element.open))) await basic.locator(':scope > summary').click();
  const leftMouse = basic.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'left mouse button' }) });
  if (!(await leftMouse.evaluate(element => element.open))) await leftMouse.locator(':scope > summary').click();
}

async function clickOgAction(page, category, action) {
  progress(`OG action: ${category} / ${action}`);
  try {
    progress(`opening OG menu category: ${category}`);
    await openOgCategory(page, category);
    progress(`clicking OG action: ${action}`);
    await page.locator(`[data-menu="${action}"]`).click();
    progress(`finished OG action: ${category} / ${action}`);
  } catch (error) {
    const menuState = await Promise.race([page.evaluate(actionName => {
      const menu = document.querySelector('.classic-menu');
      const target = document.querySelector(`[data-menu="${actionName}"]`);
      const rect = element => {
        const bounds = element?.getBoundingClientRect();
        return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null;
      };
      return {
        hidden: menu?.hidden,
        classes: menu?.className,
        fullscreen: document.fullscreenElement?.id || null,
        viewport: [window.innerWidth, window.innerHeight],
        view: rect(document.querySelector('#viewPanel')),
        menu: rect(menu),
        target: rect(target),
        targetDisplay: target ? getComputedStyle(target).display : null,
        targetVisibility: target ? getComputedStyle(target).visibility : null,
        details: [...(menu?.querySelectorAll('details') || [])].map(item => ({ summary: item.querySelector(':scope > summary')?.textContent.trim(), open: item.open }))
      };
    }, action), new Promise(resolve => setTimeout(() => resolve({ pageUnresponsive: true }), 2500))]);
    const screenshotPath = `/tmp/embryomaker-menu-${action}.png`;
    await page.screenshot({ path: screenshotPath, timeout: 3000 }).catch(() => {});
    throw new Error(`${error.message}; menu state: ${JSON.stringify(menuState)}; screenshot: ${screenshotPath}`);
  }
}

async function selectOgExample(page, id) {
  await openOgCategory(page, 'input output');
  await page.locator('#experimentMenu').selectOption(id);
}

async function openPropertyPath(page, category, path) {
  await openOgCategory(page, category);
  let current = page.locator('.classic-menu > details').filter({ hasText: category });
  for (const label of path) {
    const child = current.locator(':scope > .menu-items > details').filter({ hasText: label });
    if (await child.count() !== 1) throw new Error(`Missing OG submenu path: ${category} > ${path.join(' > ')}`);
    await child.locator(':scope > summary').hover();
    if (!(await child.evaluate(element => element.open))) throw new Error(`OG submenu did not open on hover: ${category} > ${path.join(' > ')}`);
    await child.locator(':scope > .menu-items').waitFor({ state: 'visible', timeout: Math.min(timeout, 3000) });
    current = child;
  }
}

async function menuDiagnostics(page, selector) {
  return page.evaluate(targetSelector => {
    const menu = document.querySelector('.classic-menu');
    const target = document.querySelector(targetSelector);
    const rect = element => {
      const bounds = element?.getBoundingClientRect();
      return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null;
    };
    return {
      menuHidden: menu?.hidden,
      menuClasses: menu?.className,
      targetVisible: target ? Boolean(target.offsetWidth || target.offsetHeight || target.getClientRects().length) : false,
      targetRect: rect(target),
      openBranches: [...(menu?.querySelectorAll('details[open]') || [])].map(item => item.querySelector(':scope > summary')?.textContent.trim()),
      viewport: [window.innerWidth, window.innerHeight]
    };
  }, selector);
}

async function openMechanicalProperties(page, submenu = 'with arrows (only epithelia)') {
  await openPropertyPath(page, 'show node mechanical properties', Array.isArray(submenu) ? submenu : [submenu]);
}

async function openOtherProperties(page, submenu = 'with colors') {
  await openPropertyPath(page, 'show other node properties', Array.isArray(submenu) ? submenu : [submenu]);
}

async function dragStage(page, dx, dy, button = 'left') {
  const point = await page.locator('#stage').evaluate(canvas => {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down({ button });
  await page.mouse.move(point.x + dx, point.y + dy);
  await page.mouse.up({ button });
}

async function main() {
  const httpFraming = await checkHttpFraming();
  const launchOptions = { headless: true, timeout: Math.min(timeout, 30000) };
  const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(chromePath)) launchOptions.executablePath = chromePath;
  if (process.env.UI_SMOKE_METAL === '1') {
    launchOptions.args = ['--enable-gpu', '--enable-webgl', '--use-gl=angle', '--use-angle=metal'];
  }
  if (process.env.UI_SMOKE_SINGLE_PROCESS === '1') launchOptions.args = [...(launchOptions.args || []), '--single-process', '--no-zygote'];
  let browser = null;
  try {
    progress('launching browser');
    browser = await chromium.launch(launchOptions);
    progress('browser launched');
    const page = await withTimeout(browser.newPage({ viewport: { width: 1440, height: 900 } }), timeout, 'new browser page');
    progress('created browser page');
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    const errors = [];
    const smokeOutputPrefix = `UiSmokeParity${Date.now()}_`;
    let expectingInvalidInputRejection = false;
    page.on('console', message => {
      if (message.type() === 'error' && !(expectingInvalidInputRejection && message.text().includes('status of 422'))) errors.push(`console.error: ${message.text()}`);
    });
    page.on('pageerror', error => errors.push(`uncaught page error: ${error.message}`));
    page.on('requestfailed', request => errors.push(`request failed: ${request.url()} (${request.failure()?.errorText})`));
    await withTimeout(page.addInitScript(() => {
      window.__embryomakerRuntimeErrors = [];
      window.addEventListener('error', event => window.__embryomakerRuntimeErrors.push(event.message));
      window.addEventListener('unhandledrejection', event => window.__embryomakerRuntimeErrors.push(String(event.reason)));
    }), timeout, 'browser error instrumentation');
    progress('navigating to the UI');
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    progress('UI document loaded');
    await page.waitForFunction(() => document.querySelector('#status .message')?.textContent?.startsWith('Model ready'));
    progress('initial model ready');
    await page.waitForTimeout(2100);
    if (process.env.UI_SMOKE_ITERATION_PROGRESS === '1') {
      await selectOgExample(page, 'sea_urchin');
      await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Model ready'), 'Loading Sea urchin for iteration progress');
      await page.locator('#iterationRange').evaluate(range => { range.value = '40'; range.dispatchEvent(new Event('input', { bubbles: true })); range.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitForFunction(() => document.querySelector('#iterationProgress')?.classList.contains('active'), null, { timeout });
      await page.waitForFunction(() => Number(document.querySelector('#iterationProgressBar')?.value) >= 4, null, { timeout });
      const progressDuringRun = await page.locator('#iterationProgressLabel').textContent();
      await page.locator('#iterationRange').evaluate(range => { range.value = '12'; range.dispatchEvent(new Event('input', { bubbles: true })); range.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitForFunction(() => !document.querySelector('#iterationProgress')?.classList.contains('active') && Number(document.querySelector('#iterationValue')?.textContent) === 12, null, { timeout });
      const frameBefore = await page.evaluate(() => window.embryomakerRenderer?.lastFrame?.serial || 0);
      await page.waitForFunction(serial => window.embryomakerRenderer?.lastFrame?.serial > serial, frameBefore, { timeout });
      const runtimeErrors = await page.evaluate(() => window.__embryomakerRuntimeErrors);
      for (const error of runtimeErrors) errors.push(`browser runtime error: ${error}`);
      if (errors.length) throw new Error(errors.join('\n'));
      console.log(JSON.stringify({ ok: true, experiment: 'sea_urchin', progressDuringRun, seekTarget: 12, finalIteration: 12, consoleErrors: 0, runtimeErrors: 0 }, null, 2));
      return;
    }
    if (process.env.UI_SMOKE_CONTROLS_ONLY === '1') {
      await page.locator('#fullscreenBtn').click();
      await page.waitForFunction(() => document.fullscreenElement?.id === 'viewPanel', null, { timeout });
      await page.waitForFunction(() => {
        const overlay = document.querySelector('#stage');
        const webgl = document.querySelector('#stageGL');
        return overlay.width === webgl.width && overlay.height === webgl.height;
      }, null, { timeout });
      const fullscreenGeometry = await page.evaluate(() => {
        const view = document.querySelector('#viewPanel');
        const rect = view.getBoundingClientRect();
        return { active: document.fullscreenElement === view, label: document.querySelector('#fullscreenBtn')?.getAttribute('aria-label'), width: rect.width, height: rect.height, overlay: [document.querySelector('#stage').width, document.querySelector('#stage').height], webgl: [document.querySelector('#stageGL').width, document.querySelector('#stageGL').height] };
      });
      if (!fullscreenGeometry.active || fullscreenGeometry.label !== 'Exit fullscreen' || Math.abs(fullscreenGeometry.width - 1440) > 1 || Math.abs(fullscreenGeometry.height - 900) > 1 || JSON.stringify(fullscreenGeometry.overlay) !== JSON.stringify(fullscreenGeometry.webgl)) throw new Error(`Fullscreen controls failed: ${JSON.stringify(fullscreenGeometry)}`);
      await page.locator('#fullscreenBtn').click();
      await page.waitForFunction(() => document.fullscreenElement === null && document.querySelector('#fullscreenBtn')?.getAttribute('aria-label') === 'Enter fullscreen', null, { timeout });

      const iterationBeforeRun = Number(await page.locator('#iterationValue').textContent());
      await page.locator('#stage').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(previous => Number(document.querySelector('#iterationValue')?.textContent) > previous, iterationBeforeRun, { timeout });
      const keyboardRunIteration = Number(await page.locator('#iterationValue').textContent());
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(previous => Number(document.querySelector('#iterationValue')?.textContent) === previous - 1, keyboardRunIteration, { timeout });
      const rewoundIteration = Number(await page.locator('#iterationValue').textContent());
      await clickOgAction(page, 'input output', 'reset-model');
      await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Model ready at iteration 0'), 'Reset after keyboard transport');
      const runtimeErrors = await page.evaluate(() => window.__embryomakerRuntimeErrors);
      for (const error of runtimeErrors) errors.push(`browser runtime error: ${error}`);
      if (errors.length) throw new Error(errors.join('\n'));
      console.log(JSON.stringify({ ok: true, fullscreenGeometry, transport: { keyboardRunIteration, rewoundIteration, resetIteration: 0 }, consoleErrors: 0, runtimeErrors: 0 }, null, 2));
      return;
    }
    if (!(await page.locator('.left-panel').isVisible())) throw new Error('Studio controls must be visible on launch');
    await page.locator('#workspaceToggle').click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#status')).opacity === '0');
    const ogDisplayDefaults = await page.evaluate(() => ({
      colorMode: document.querySelector('#colorMode')?.value,
      palette: document.querySelector('#paletteMode')?.value,
      camera: document.querySelector('#cameraPreset')?.value,
      legend: document.querySelector('#legend')?.textContent?.replace(/\s+/g, ' ').trim(),
      rangeHidden: document.querySelector('#colorRangeControls')?.hidden,
      menuButtonHidden: getComputedStyle(document.querySelector('#openMenuBtn')).display === 'none',
      statusOpacity: getComputedStyle(document.querySelector('#status')).opacity,
      colorRange: [Number(document.querySelector('#colorMinimum')?.value), Number(document.querySelector('#colorMaximum')?.value)],
      frame: window.embryomakerRenderer?.lastFrame
    }));
    if (ogDisplayDefaults.colorMode !== 'type' || ogDisplayDefaults.palette !== 'multi' || ogDisplayDefaults.camera !== 'oblique' || !ogDisplayDefaults.legend.includes('1.00') || !ogDisplayDefaults.legend.endsWith('7.00') || ogDisplayDefaults.rangeHidden || !ogDisplayDefaults.menuButtonHidden || ogDisplayDefaults.statusOpacity !== '0' || ogDisplayDefaults.colorRange[0] !== 1 || ogDisplayDefaults.colorRange[1] !== 7 || ogDisplayDefaults.frame?.radiusMode !== 'eqd' || ogDisplayDefaults.frame?.displayBox || ogDisplayDefaults.frame?.underlayLineVertices !== 0 || Math.abs(ogDisplayDefaults.frame.cameraPitch - 135 * Math.PI / 180) > 1e-6 || ogDisplayDefaults.frame.cameraDistance !== 12) {
      throw new Error(`Original EmbryoMaker display defaults did not load: ${JSON.stringify(ogDisplayDefaults)}`);
    }
    await page.locator('#workspaceToggle').click();
    if (!(await page.locator('.left-panel').isVisible()) || !(await page.locator('.right-panel').isVisible())) throw new Error('Studio controls did not open from the parity view');
    const studioGeometry = await page.evaluate(() => ({ viewport: [document.documentElement.clientWidth, document.documentElement.clientHeight], document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], panels: ['.left-panel','.view-panel','.right-panel'].map(selector => { const element=document.querySelector(selector),rect=element.getBoundingClientRect();return {selector,height:rect.height,bottom:rect.bottom,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight}; }) }));
    if (studioGeometry.document[0] > studioGeometry.viewport[0] || studioGeometry.document[1] > studioGeometry.viewport[1] || studioGeometry.panels.some(panel => panel.bottom > studioGeometry.viewport[1] + 1)) throw new Error(`Studio panels exceed the viewport: ${JSON.stringify(studioGeometry)}`);
    await page.locator('#workspaceToggle').click();
    if (await page.locator('.left-panel').isVisible()) throw new Error('Studio controls did not close back to the parity view');
    const configuredPropertyCodes = await page.evaluate(() => [[31,'color'],[33,'color'],[42,'color'],[43,'color'],[44,'color'],[43,'arrow'],[44,'sphere']].map(([code,channel]) => window.embryomakerDisplayConfig.propertyForCode(code,channel)));
    if (JSON.stringify(configuredPropertyCodes) !== JSON.stringify(['other', 'talone', 'index', 'lineage', 'gene_1', 'gene_1', 'gene_2'])) throw new Error(`OG config property codes differ from drawer.mod.f90: ${JSON.stringify(configuredPropertyCodes)}`);
    const examplesResponse = await page.request.get(apiUrl('/api/examples'));
    if (!examplesResponse.ok()) throw new Error(`GET /api/examples returned ${examplesResponse.status()}`);
    const { examples } = await examplesResponse.json();
    progress(`waiting for ${examples.length} OG example options`);
    try {
      await page.waitForFunction(expected => document.querySelectorAll('#experimentMenu option').length === expected, examples.length, { timeout });
    } catch (error) {
      const diagnostics = await Promise.race([page.evaluate(() => ({
        optionCount: document.querySelectorAll('#experimentMenu option').length,
        selectedExample: document.querySelector('#experimentMenu')?.value,
        status: document.querySelector('#status .message')?.textContent,
        runtimeErrors: window.__embryomakerRuntimeErrors,
        loadedScripts: [...document.scripts].map(script => script.src || 'inline')
      })), new Promise(resolve => setTimeout(() => resolve({ pageUnresponsive: true }), 2500))]);
      throw new Error(`OG example menu did not populate ${examples.length} options: ${JSON.stringify(diagnostics)}; ${error.message}`);
    }
    progress(`loaded ${examples.length} OG example options`);

    const loaded = [];
    let liveForceVectors = null;
    for (const example of examples) {
      progress(`loading example ${example.id}`);
      const previousFrame = await page.evaluate(() => window.embryomakerRenderer?.lastFrame?.serial || 0);
      if (await page.locator('#experimentMenu').inputValue() === example.id) await clickOgAction(page, 'input output', 'reset-model');
      else await selectOgExample(page, example.id);
      const status = await waitForStatus(page,
        () => document.querySelector('#status .message')?.textContent.startsWith('Model ready'),
        `Loading ${example.id}`);
      await page.waitForFunction(previous => {
        const frame = window.embryomakerRenderer?.lastFrame;
        return frame?.serial > previous && frame.visibleNodes > 0 && frame.drawCalls > 0 && frame.glError === 0;
      }, previousFrame, { timeout });
      if (example.id === 'figure_6' && !status.includes('iteration 1')) throw new Error('Figure 6 did not preserve its saved starting iteration');
      const geometry = await page.locator('#stage').evaluate(canvas => {
        const rect = canvas.getBoundingClientRect();
        const glCanvas = document.querySelector('#stageGL');
        const gl = glCanvas?.getContext('webgl');
        const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info');
        const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null;
        return { width: rect.width, height: rect.height, backingWidth: canvas.width, backingHeight: canvas.height, webgl: Boolean(gl), renderer, glWidth: glCanvas?.width || 0, glHeight: glCanvas?.height || 0, glError: gl?.getError(), frame: window.embryomakerRenderer?.lastFrame };
      });
      if (geometry.width <= 0 || geometry.height <= 0 || geometry.backingWidth <= 0 || geometry.backingHeight <= 0 || !geometry.webgl || geometry.glWidth !== geometry.backingWidth || geometry.glHeight !== geometry.backingHeight || geometry.glError !== 0 || geometry.frame?.visibleNodes <= 0 || geometry.frame?.drawCalls <= 0 || geometry.frame?.antialias !== false) {
        throw new Error(`${example.id} has invalid visualization geometry or a WebGL error: ${JSON.stringify(geometry)}`);
      }
      if (example.id === examples[0].id && (Math.abs(geometry.width - 800) > 1 || Math.abs(geometry.height - 800) > 1)) {
        throw new Error(`OG desktop viewport must be 800 by 800 CSS pixels: ${JSON.stringify(geometry)}`);
      }
      if (process.env.UI_SMOKE_METAL === '1' && !geometry.renderer?.includes('ANGLE Metal Renderer')) {
        throw new Error(`Metal smoke requested, but WebGL selected ${geometry.renderer || 'an unknown renderer'}`);
      }
      if (example.id.startsWith('morphospace_')) {
        const before = Number(await page.locator('#iterationValue').textContent());
        await page.evaluate(() => document.querySelector('#stepBtn').click());
        await page.waitForFunction(value => Number(document.querySelector('#iterationValue')?.textContent) === value + 1, before, { timeout });
      }
      if (example.id === 'apoptosis') {
        await page.evaluate(() => document.querySelector('#stepBtn').click());
        await waitForStatus(page, () => document.querySelector('#iterationValue')?.textContent === '1', 'Apoptosis solver step');
        const model = await readCurrentModel(page);
        const nonzeroRepulsion = model.nodes.filter(node => Math.hypot(node.repX, node.repY, node.repZ) > 1e-12).length;
        if (!nonzeroRepulsion) throw new Error('Apoptosis step produced no serialized OG adhesion/repulsion display vectors.');
        const forcePreviousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
        await clickOgAction(page, 'what to draw', 'repulsion-toggle');
        await waitForNextRender(page, forcePreviousRender, 'Live apoptosis repulsion vectors');
        const forceFrame = await page.evaluate(() => window.embryomakerRenderer.lastFrame);
        if (forceFrame.underlayLineVertices <= 0 || forceFrame.glError !== 0) throw new Error(`Live apoptosis force vectors did not reach WebGL: ${JSON.stringify(forceFrame)}`);
        liveForceVectors = { nodes: model.nodes.length, nodesWithRepulsion: nonzeroRepulsion, renderedLineVertices: forceFrame.underlayLineVertices };
        await clickOgAction(page, 'what to draw', 'repulsion-toggle');
      }
      loaded.push({ id: example.id, status, nodes: (await page.locator('#nodeCount').textContent()).trim(), renderer: geometry.renderer });
      progress(`loaded example ${example.id}`);
    }

    const slicePlotParity = await page.evaluate(async () => {
      const entry = performance.getEntriesByType('resource').reverse().find(item => new URL(item.name).pathname.match(/^\/api\/session\/[^/]+\/advance$/));
      if (!entry) throw new Error('Could not find the active simulation URL for OG slice sampling');
      const modelResponse = await fetch(entry.name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps: 0 }) });
      const model = await modelResponse.json();
      const coordinates = model.nodes.map(node => [node.x, node.y, node.z]);
      const plot = await window.embryomakerPlotSlice('z', 'min', 0, 1, false);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const afterResponse = await fetch(entry.name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps: 0 }) });
      const after = await afterResponse.json();
      const coordinatesRestored = after.nodes.every((node, index) => [node.x,node.y,node.z].every((value, axis) => value === coordinates[index][axis]));
      return { resolution: plot.resolution, samples: plot.samples, coordinatesRestored, renderedPoints: window.embryomakerRenderer.lastFrame.slicePlotPoints, glError: window.embryomakerRenderer.lastFrame.glError, range: [plot.minimum, plot.maximum] };
    });
    if (slicePlotParity.resolution !== 1 || slicePlotParity.samples !== 4 || slicePlotParity.renderedPoints !== 4 || !slicePlotParity.coordinatesRestored || slicePlotParity.glError !== 0 || !slicePlotParity.range.every(Number.isFinite)) throw new Error(`Flow OG slice sampling failed: ${JSON.stringify(slicePlotParity)}`);

    const ogDrawMenu = await page.evaluate(() => {
      const menu = [...document.querySelectorAll('.classic-menu details')].find(item => item.querySelector('summary')?.textContent.trim() === 'what to draw');
      return [...menu.querySelectorAll('.menu-items button')].map(button => button.textContent.trim());
    });
    const expectedOgDrawMenu = ['epithelial springs','box grid','connexions between cells','connexions between nodes','draw cell contour','draw intercellular contour','balls as radius=EQD','balls as radius=ADD','small balls','no balls','cylinders','only upper balls','only lower balls','display box boundaries','polarization vectors','centroids','fixed nodes','show displacement of nodes from origin','movement unitary vectors','force component: repulson-adhesion','force component: epi. surface tension lateral','force component: epi. surface tension apical/basal','movement module vectors','do not show/show epithelium','do not show/show mesenchyme','do not show/show extracellular matrix','Ellongated cells as ellipses'];
    if (JSON.stringify(ogDrawMenu) !== JSON.stringify(expectedOgDrawMenu)) throw new Error(`OG what-to-draw menu order differs from the source: ${JSON.stringify(ogDrawMenu)}`);
    const ogPropertyMenus = await page.evaluate(() => Object.fromEntries(['ogMechanicalColor','ogMechanicalArrow','ogMechanicalSphere','ogOtherColor','ogOtherArrow','ogOtherSphere'].map(id => [id,[...document.getElementById(id).options].map(option => option.value)])));
    const expectedMechanical = ['scalar:x','scalar:y','scalar:z','scalar:eqd','scalar:radius','scalar:you','scalar:adh','scalar:rep','scalar:rec','scalar:erp','scalar:est','scalar:eqs','scalar:hoo','scalar:mov','scalar:dmo','scalar:z0','scalar:ecm','scalar:cod','scalar:grd','scalar:pld','scalar:vod','scalar:dif','scalar:kfi','scalar:pla','scalar:kvol'];
    const expectedOtherColor = ['type','cells','scalar:marge','scalar:fixed','scalar:ndiv','scalar:phase','scalar:dx','scalar:dy','scalar:dz','scalar:dtotal','scalar:box','scalar:index','scalar:lineage'];
    const expectedOtherVector = expectedOtherColor.filter(value => !['scalar:ndiv','scalar:lineage'].includes(value));
    if (['ogMechanicalColor','ogMechanicalArrow','ogMechanicalSphere'].some(id => JSON.stringify(ogPropertyMenus[id]) !== JSON.stringify(expectedMechanical)) || JSON.stringify(ogPropertyMenus.ogOtherColor.slice(0,expectedOtherColor.length)) !== JSON.stringify(expectedOtherColor) || JSON.stringify(ogPropertyMenus.ogOtherArrow.slice(0,expectedOtherVector.length)) !== JSON.stringify(expectedOtherVector) || JSON.stringify(ogPropertyMenus.ogOtherSphere.slice(0,expectedOtherVector.length)) !== JSON.stringify(expectedOtherVector)) throw new Error(`OG property selectors differ from the source menu options: ${JSON.stringify(ogPropertyMenus)}`);
    const expectedPropertySubmenus = ['with colors','with arrows (only epithelia)','with semitransparent spheres','color options','arrow options','sphere options'];
    const actualPropertySubmenus = await page.evaluate(() => Object.fromEntries(['show node mechanical properties','show other node properties'].map(name => { const root=[...document.querySelectorAll('.classic-menu > details')].find(item=>item.querySelector(':scope > summary')?.textContent.trim()===name); return [name,[...root.querySelectorAll(':scope > .menu-items > details > summary')].map(summary=>summary.textContent.trim())]; })));
    if (Object.values(actualPropertySubmenus).some(items => JSON.stringify(items) !== JSON.stringify(expectedPropertySubmenus))) throw new Error(`OG property submenu structure differs from the source: ${JSON.stringify(actualPropertySubmenus)}`);
    await openOgMenu(page);
    const drawCategory = page.locator('.classic-menu > details').filter({ hasText: 'what to draw' });
    const inputCategory = page.locator('.classic-menu > details').filter({ hasText: 'input output' });
    await drawCategory.locator(':scope > summary').hover();
    if (!(await drawCategory.evaluate(item => item.open))) throw new Error('OG menu category did not open on hover');
    await inputCategory.locator(':scope > summary').hover();
    if (await drawCategory.evaluate(item => item.open) || !(await inputCategory.evaluate(item => item.open))) throw new Error('OG menu hover did not switch the active top-level category');
    const basicCategory = page.locator('.classic-menu > details').filter({ hasText: 'Basic View Modifier' });
    await basicCategory.locator(':scope > summary').hover();
    const leftMouseCategory = basicCategory.locator(':scope > .menu-items > details').filter({ hasText: 'left mouse button' });
    await leftMouseCategory.locator(':scope > summary').hover();
    if (!(await basicCategory.evaluate(item => item.open)) || !(await leftMouseCategory.evaluate(item => item.open))) throw new Error('OG nested submenu did not open on hover');
    await openOgCategory(page, 'Basic View Modifier');
    await page.locator('.classic-menu summary').filter({ hasText: 'left mouse button' }).click();
    for (const action of ['drag-rotate','drag-zoom','drag-pan','section-minx','section-maxx','section-miny','section-maxy','section-minz','section-maxz']) {
      if (!(await page.locator(`[data-menu="${action}"]`).first().isVisible())) throw new Error(`OG left mouse menu is missing ${action}`);
    }
    let previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await page.locator('[data-menu="section-minx"]').click();
    await waitForNextRender(page, previousRender, 'Set minimum x section');
    await clickOgAction(page, 'what to draw', 'box-toggle');
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await page.locator('#sectionPosition').evaluate(input => { input.value = '50'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await waitForNextRender(page, previousRender, 'Move minimum x section');
    const sectionBoxFrame = await page.evaluate(() => window.embryomakerRenderer.lastFrame);
    const expectedSectionX = sectionBoxFrame.sceneBounds[0] + (sectionBoxFrame.sceneBounds[1] - sectionBoxFrame.sceneBounds[0]) * .5;
    if (Math.abs(sectionBoxFrame.displayBounds[0] - expectedSectionX) > 1e-9 || sectionBoxFrame.displayBounds[1] !== sectionBoxFrame.sceneBounds[1] || sectionBoxFrame.underlayLineVertices !== 24 || Math.abs(sectionBoxFrame.underlayLineSamples[0][0][0] - expectedSectionX) > 1e-6 || sectionBoxFrame.glError !== 0) {
      throw new Error(`OG section plane did not move the displayed box face with its clipping boundary: ${JSON.stringify(sectionBoxFrame)}`);
    }
    previousRender = sectionBoxFrame.serial;
    await clickOgAction(page, 'Basic View Modifier', 'section-off');
    await waitForNextRender(page, previousRender, 'Undo x section');
    await clickOgAction(page, 'what to draw', 'box-toggle');
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await openOtherProperties(page);
    await page.locator('#ogOtherColor').selectOption('cells');
    await page.waitForFunction(({ previous, field }) => {
      const frame = window.embryomakerRenderer?.lastFrame;
      return frame?.serial > previous && frame.colorField === field && frame.colorRangeField === field && frame.visibleNodes > 0 && frame.glError === 0;
    }, { previous: previousRender, field: 'cell' }, { timeout });
    const currentCellColoring = await page.evaluate(() => ({ legend: document.querySelector('#legend')?.textContent?.replace(/\s+/g, ' ').trim(), frame: window.embryomakerRenderer?.lastFrame, range: [Number(document.querySelector('#colorMinimum').value), Number(document.querySelector('#colorMaximum').value)] }));
    if (!currentCellColoring.legend?.toLowerCase().includes('cells') || currentCellColoring.frame?.colorField !== 'cell' || currentCellColoring.frame?.colorRangeField !== 'cell' || JSON.stringify(currentCellColoring.frame?.colorRange) !== JSON.stringify(currentCellColoring.range)) {
      throw new Error(`OG cells coloring did not use current cell IDs and their current range: ${JSON.stringify(currentCellColoring)}`);
    }
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await openOtherProperties(page);
    await page.locator('#ogOtherColor').selectOption('scalar:lineage');
    await waitForNextRender(page, previousRender, 'Original cell lineage color field');
    if (await page.evaluate(() => window.embryomakerRenderer.lastFrame.colorField !== 'lineage' || window.embryomakerRenderer.lastFrame.colorRangeField !== 'lineage')) throw new Error('OG cell lineage coloring did not use original node cell IDs');
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await openOtherProperties(page);
    await page.locator('#ogOtherColor').selectOption('type');
    await openMechanicalProperties(page, ['color options','change color palette']);
    await page.locator('[data-menu="palette-warm"]').first().click();
    await waitForNextRender(page, previousRender, 'Original warm palette');
    await openOtherProperties(page);
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await page.evaluate(() => { const minimum = document.querySelector('#ogOtherColorMinimum'), maximum = document.querySelector('#ogOtherColorMaximum'); minimum.value = '2'; maximum.value = '6'; minimum.dispatchEvent(new Event('change')); maximum.dispatchEvent(new Event('change')); });
    await waitForNextRender(page, previousRender, 'OG custom color limits');
    if (!(await page.locator('#legend').textContent()).includes('2.00') || !(await page.locator('#legend').textContent()).endsWith('6.00')) throw new Error('OG custom color limits did not update the selected property range');
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await page.evaluate(() => { const minimum = document.querySelector('#ogOtherColorMinimum'), maximum = document.querySelector('#ogOtherColorMaximum'); minimum.value = '1'; maximum.value = '7'; minimum.dispatchEvent(new Event('change')); maximum.dispatchEvent(new Event('change')); });
    await waitForNextRender(page, previousRender, 'Restore OG type color limits');
    await openPropertyPath(page, 'show other node properties', ['color options']);
    await page.locator('[data-menu="color-min-left"]').last().click();
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await dragStage(page, 0, 2);
    await waitForNextRender(page, previousRender, 'OG left mouse color minimum');
    const draggedColorRange = await page.evaluate(() => window.embryomakerRenderer.lastFrame.colorRange);
    if (Math.abs(draggedColorRange[0] - 0.8) > 1e-9 || draggedColorRange[1] !== 7) throw new Error(`OG left mouse color drag did not apply the source range formula: ${JSON.stringify(draggedColorRange)}`);
    await page.evaluate(() => { const minimum = document.querySelector('#ogOtherColorMinimum'), maximum = document.querySelector('#ogOtherColorMaximum'); minimum.value = '1'; maximum.value = '7'; minimum.dispatchEvent(new Event('change')); maximum.dispatchEvent(new Event('change')); });
    await openMechanicalProperties(page);
    progress(`opened mechanical arrow selector: ${JSON.stringify(await menuDiagnostics(page, '#ogMechanicalArrow'))}`);
    await page.locator('#ogMechanicalArrow').selectOption('scalar:x');
    progress('selected mechanical arrow scale property');
    await openPropertyPath(page, 'show node mechanical properties', ['arrow options']);
    await page.locator('[data-menu="arrow-scale-left"]').first().click();
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await dragStage(page, 0, 2);
    await waitForNextRender(page, previousRender, 'OG left mouse arrow scale');
    const draggedArrowScale = await page.evaluate(() => window.embryomakerRenderer.lastFrame.arrowScale);
    if (Math.abs(draggedArrowScale - 0.8) > 1e-9) throw new Error(`OG left mouse arrow scale did not apply the source formula: ${draggedArrowScale}`);
    await openPropertyPath(page, 'show node mechanical properties', ['arrow options']);
    await page.locator('[data-menu="arrow-disable"]').first().click();
    let cylinderToggles = 0;
    let spheresWithoutCylinders = 0;
    for (const displayMode of ['balls-cylinders', 'balls-cylinders', 'balls-small', 'balls-small', 'balls-none', 'balls-none']) {
      await openWhatToDraw(page);
      previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
      await page.locator(`[data-menu="${displayMode}"]`).click();
      await waitForNextRender(page, previousRender, displayMode);
      if (displayMode === 'balls-cylinders') {
        cylinderToggles++;
        const frame = await page.evaluate(() => window.embryomakerRenderer.lastFrame);
        if (cylinderToggles === 1) {
          spheresWithoutCylinders = frame.sphereInstances;
          if (spheresWithoutCylinders !== frame.visibleNodes) throw new Error(`Cylinder toggle did not replace the full node set with spheres: ${JSON.stringify(frame)}`);
        } else if (frame.sphereInstances >= spheresWithoutCylinders) {
          throw new Error(`Cylinder toggle did not restore epithelial cylinders: ${JSON.stringify(frame)}`);
        }
      }
    }
    await openWhatToDraw(page);
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await page.locator('[data-menu="spring-toggle"]').click();
    await waitForNextRender(page, previousRender, 'Epithelial springs');
    for (const overlay of ['grid-toggle', 'box-toggle', 'ellipses-toggle', 'centroids-toggle', 'polarization-toggle', 'displacement-toggle']) {
      await openWhatToDraw(page);
      previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
      const previousLineVertices = await page.evaluate(() => window.embryomakerRenderer.lastFrame.gridLineVertices);
      const overlayButton = page.locator(`[data-menu="${overlay}"]`);
      await overlayButton.click();
      await waitForNextRender(page, previousRender, overlay);
      if (overlay === 'grid-toggle') {
        const gridFrame = await page.evaluate(() => window.embryomakerRenderer.lastFrame);
        const gridIndex = gridFrame.renderOrder.indexOf('grid-lines'), nodeIndex = Math.max(gridFrame.renderOrder.indexOf('nodes'), gridFrame.renderOrder.indexOf('nodes-arrows-and-transparent-spheres-by-id'), gridFrame.renderOrder.indexOf('node-geometry-by-id'));
        if (gridFrame.gridLineVertices <= previousLineVertices || gridIndex < 0 || nodeIndex < 0 || gridIndex >= nodeIndex) throw new Error(`OG box grid geometry or pass order failed: ${JSON.stringify(gridFrame)}`);
      }
      if (overlay === 'ellipses-toggle' && !(await page.evaluate(() => window.embryomakerRenderer.lastFrame.showEllipses))) {
        throw new Error('OG elongated-cell display toggle did not enable');
      }
    }
    const ellipseGeometry = await page.evaluate(() => {
      window.embryomakerRenderer.render([{ id: 1, other: 0, x: 0, y: 0, z: 0, type: 3, radius: .2, addRadius: .2, color: '#ff0000', visible: true, display: true, polx: 0, poly: 1, polz: 0, elongationFactor: 2 }], { yaw: 0, pitch: Math.PI / 3, zoom: 1, panX: 0, panY: 0, pointScale: 1, showCylinders: false, smallBalls: false, noBalls: false, showNodes: true, showEllipses: true, showBox: false, radiusMode: 'add', showGrid: false, gridSpacing: 0, gridCount: 0 });
      return window.embryomakerRenderer.lastFrame;
    });
    if (ellipseGeometry.ellipticalInstances !== 1 || ellipseGeometry.sphereInstances !== 1 || ellipseGeometry.glError !== 0) throw new Error(`Elongated-cell shader did not render its test ellipsoid: ${JSON.stringify(ellipseGeometry)}`);
    const overlaySphereParity = await page.evaluate(() => {
      const gl = document.getElementById('stageGL').getContext('webgl');
      const node = { id: 1, other: 0, x: 0, y: 0, z: 0, type: 3, radius: .5, addRadius: .5, color: '#ff0000', visible: true, display: true, polx: 0, poly: 0, polz: 0 };
      const options = { yaw: 0, pitch: Math.PI / 3, zoom: 1, panX: 0, panY: 0, pointScale: 1, showCylinders: false, smallBalls: false, noBalls: false, showNodes: true, showEllipses: false, showBox: false, radiusMode: 'add', showGrid: false, gridSpacing: 0, gridCount: 0 };
      const capture = () => { const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4); gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels); return pixels; };
      window.embryomakerRenderer.render([node], options);
      const instanced = capture();
      window.embryomakerRenderer.render([node], { ...options, showArrows: true, arrowRange: [0, 0] });
      const ordered = capture();
      let differingComponents = 0, maximumDelta = 0;
      for (let i = 0; i < instanced.length; i++) { const delta = Math.abs(instanced[i] - ordered[i]); if (delta) differingComponents++; maximumDelta = Math.max(maximumDelta, delta); }
      return { differingComponents, maximumDelta, components: instanced.length, glError: gl.getError() };
    });
    if (overlaySphereParity.glError !== 0 || overlaySphereParity.differingComponents > 32 || overlaySphereParity.maximumDelta > 2) throw new Error(`OG sphere pixels changed when the renderer entered its ordered overlay path: ${JSON.stringify(overlaySphereParity)}`);
    const litNodePixels = await page.evaluate(() => {
      const gl = document.getElementById('stageGL').getContext('webgl');
      window.embryomakerRenderer.render([{ id: 1, other: 0, x: 0, y: 0, z: 0, type: 3, radius: .5, addRadius: .5, color: '#ff0000', visible: true, display: true, polx: 0, poly: 0, polz: 0 }], { yaw: 0, pitch: 3 * Math.PI / 4, zoom: 1, panX: 0, panY: 0, pointScale: 1, showCylinders: false, smallBalls: false, noBalls: false, showNodes: true, showEllipses: false, showBox: false, radiusMode: 'add', showGrid: false, gridSpacing: 0, gridCount: 0 });
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const red = [], centerX = gl.drawingBufferWidth / 2, centerY = gl.drawingBufferHeight / 2;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const pixel = offset / 4, x = pixel % gl.drawingBufferWidth, y = Math.floor(pixel / gl.drawingBufferWidth);
        if ((x - centerX) ** 2 + (y - centerY) ** 2 < 35 ** 2 && pixels[offset] > 20 && pixels[offset + 1] < 3 && pixels[offset + 2] < 3 && pixels[offset + 3] === 255) red.push(pixels[offset]);
      }
      red.sort((a, b) => a - b);
      return { minimumRed: red[0], tenthPercentileRed: red[Math.floor(red.length * 0.1)], maximumRed: red.at(-1), redPixels: red.length, error: gl.getError() };
    });
    if (litNodePixels.error !== 0 || litNodePixels.minimumRed < 125 || litNodePixels.minimumRed > 170 || litNodePixels.tenthPercentileRed < 130 || litNodePixels.tenthPercentileRed > 225 || litNodePixels.maximumRed < 250 || litNodePixels.redPixels < 100) throw new Error(`OG default-view sphere lighting or ambient shading did not match: ${JSON.stringify(litNodePixels)}`);
    const transparentGeometry = await page.evaluate(() => {
      const base = { other: 0, y: 0, z: 0, type: 1, radius: .2, addRadius: .2, color: '#ff0000', visible: true, display: true, polx: 0, poly: 0, polz: 0, transparentRadius: .2 };
      window.embryomakerRenderer.render([{ ...base, id: 2, cell: 2, x: .5, transparentValue: 1 }, { ...base, id: 1, cell: 1, x: 0, transparentValue: 2 }], { yaw: 0, pitch: Math.PI / 3, zoom: 1, panX: 0, panY: 0, pointScale: 1, showCylinders: false, smallBalls: false, noBalls: false, showNodes: true, showEllipses: false, showTransparentSpheres: true, transparentRange: [0, 1], transparentScale: 1, showBox: false, radiusMode: 'add', showGrid: false, gridSpacing: 0, gridCount: 0 });
      return window.embryomakerRenderer.lastFrame;
    });
    const expectedTransparentDrawOrder = [{ id: 1, layer: 'node' }, { id: 1, layer: 'transparent' }, { id: 2, layer: 'node' }, { id: 2, layer: 'transparent' }];
    if (transparentGeometry.canvasAlpha !== false || transparentGeometry.transparentSphereCount !== 2 || transparentGeometry.transparentRadii[0] !== 2 || transparentGeometry.transparentRadii[1] !== 1 || Math.abs(transparentGeometry.transparentDisplayRadii[0] - 0.2) > 1e-12 || transparentGeometry.transparentSphereSlices !== 10 || transparentGeometry.transparentSphereStacks !== 30 || transparentGeometry.sphereSlices !== 10 || transparentGeometry.sphereStacks !== 10 || transparentGeometry.spherePolarAxis !== 'z' || !(transparentGeometry.sphereAzimuthSample[0] > 0 && transparentGeometry.sphereAzimuthSample[1] > 0) || transparentGeometry.cursorSphereSlices !== 4 || JSON.stringify(transparentGeometry.transparentDrawOrder) !== JSON.stringify(expectedTransparentDrawOrder) || transparentGeometry.glError !== 0) throw new Error(`OG sphere orientation, opaque canvas, alpha draw order, or transparent shader pass failed: ${JSON.stringify(transparentGeometry)}`);
    const cursorNodeLoop = await page.evaluate(() => {
      const base = { other: 0, x: 0, y: 0, z: 0, type: 3, radius: .2, addRadius: .2, color: '#ff0000', display: true, polx: 0, poly: 0, polz: 0 };
      window.embryomakerRenderer.render([{ ...base, id: 1, visible: true }, { ...base, id: 2, visible: false }], { yaw: 0, pitch: Math.PI / 3, zoom: 1, panX: 0, panY: 0, pointScale: 1, showCylinders: false, smallBalls: false, noBalls: false, showNodes: true, showEllipses: false, showBox: false, radiusMode: 'add', showGrid: false, gridSpacing: 0, gridCount: 0, cursor: { enabled: true, x: 0, y: 0, z: 0 } });
      return window.embryomakerRenderer.lastFrame.nodeLoopOrder;
    });
    const expectedCursorNodeLoop = [{ nodeId: 1, layer: 'cursor' }, { nodeId: 1, layer: 'node' }, { nodeId: 2, layer: 'cursor' }];
    if (JSON.stringify(cursorNodeLoop) !== JSON.stringify(expectedCursorNodeLoop)) throw new Error(`OG cursor and node loop order differed: ${JSON.stringify(cursorNodeLoop)}`);
    const arrowGeometry = await page.evaluate(() => {
      const base = { type: 1, radius: .2, addRadius: .2, color: '#ff0000', visible: true, display: true, fixed: false, polx: 0, poly: 0, polz: 0, elongationFactor: 1 };
      window.embryomakerRenderer.render([{ ...base, id: 1, other: 2, cell: 1, x: 0, y: 0, z: 0, arrowValue: 1.5, transparentValue: 1 }, { ...base, id: 2, other: 1, cell: 2, type: 2, color: '#00ff00', x: 1, y: 0, z: 0, arrowValue: 0, transparentValue: 0 }], { yaw: 0, pitch: Math.PI / 3, zoom: 1, panX: 0, panY: 0, pointScale: 1, showCylinders: true, smallBalls: false, noBalls: false, showNodes: true, showEllipses: false, showTransparentSpheres: true, transparentRange: [0, 1], transparentScale: 1, showArrows: true, arrowField: 'scalar:energy', arrowRange: [0, 1], arrowScale: 1, showBox: false, showGrid: false, gridSpacing: 0, gridCount: 0 });
      return window.embryomakerRenderer.lastFrame;
    });
    const expectedNodeOverlayOrder = [{ id: 1, layer: 'node' }, { id: 1, layer: 'arrow' }, { id: 1, layer: 'transparent' }, { id: 2, layer: 'node' }];
    const primitiveOrder = arrowGeometry.orderedPrimitiveOrder;
    const nodeOneArrowCommands = primitiveOrder.filter(command => command.id === 1 && (command.layer === 'arrow' || command.layer === 'arrow-outline'));
    const nodeOneCylinderCommands = primitiveOrder.filter(command => command.id === 1 && (command.layer === 'node' || command.layer === 'node-outline'));
    const arrowSurfaceCommands = nodeOneArrowCommands.filter(command => command.layer === 'arrow');
    const arrowOutlineCommands = nodeOneArrowCommands.filter(command => command.layer === 'arrow-outline');
    const interleavesFaceAndOutline = (commands, segments) => commands.length === segments * 2 && commands.every((command, index) => command.mode === (index % 2 ? 'lines' : 'triangles'));
    const staysInGeometry = (commands, vertexCount) => commands.length > 0 && Math.max(...commands.map(command => command.first + command.count)) <= Math.min(...commands.map(command => command.first)) + vertexCount;
    const arrowPosition = primitiveOrder.findIndex(command => command.id === 1 && command.layer === 'arrow');
    const transparentPosition = primitiveOrder.findIndex(command => command.id === 1 && command.layer === 'transparent');
    const expectedCylinderCapNormal = 0.2 ** 2 * Math.sin(Math.PI / 5), expectedArrowCapNormal = 0.1;
    if (arrowGeometry.arrowCount !== 1 || arrowGeometry.arrowColorCompensation !== 1.3 || arrowGeometry.arrowTriangleVertices <= 0 || arrowGeometry.arrowOutlineVertices < 24 || arrowGeometry.glError !== 0 || JSON.stringify(arrowGeometry.transparentDrawOrder) !== JSON.stringify(expectedNodeOverlayOrder) || !interleavesFaceAndOutline(nodeOneArrowCommands, 12) || !interleavesFaceAndOutline(nodeOneCylinderCommands, 10) || !staysInGeometry(arrowSurfaceCommands, arrowGeometry.arrowTriangleVertices) || !staysInGeometry(arrowOutlineCommands, arrowGeometry.arrowOutlineVertices) || arrowPosition < 0 || transparentPosition <= arrowPosition || arrowGeometry.drawCalls < primitiveOrder.length || Math.abs(arrowGeometry.cylinderCapNormalSample[0] - expectedCylinderCapNormal) > 1e-6 || Math.abs(arrowGeometry.arrowCapNormalSample[0] - expectedArrowCapNormal) > 1e-6 || Math.abs(arrowGeometry.cylinderCapNormalSample[1]) > 1e-6 || Math.abs(arrowGeometry.cylinderCapNormalSample[2]) > 1e-6 || Math.abs(arrowGeometry.arrowCapNormalSample[1]) > 1e-6 || Math.abs(arrowGeometry.arrowCapNormalSample[2]) > 1e-6) throw new Error(`OG node, arrow, cylinder outline, or source normal lengths differ: ${JSON.stringify(arrowGeometry)}`);
    if (!(arrowGeometry.arrowVectors[0].end[0] < arrowGeometry.arrowVectors[0].origin[0])) throw new Error(`OG property arrow points away from its paired node incorrectly: ${JSON.stringify(arrowGeometry.arrowVectors[0])}`);
    if (arrowGeometry.arrowVectors[0].end[0] !== -1.5) throw new Error(`OG property arrow clamped its custom range value: ${JSON.stringify(arrowGeometry.arrowVectors[0])}`);
    const movementVectorGeometry = await page.evaluate(() => {
      const base = { type: 3, radius: .2, addRadius: .2, color: '#ff0000', visible: true, display: true, fixed: false, polx: 0, poly: 0, polz: 0, moveY: 0, moveZ: 0 };
      window.embryomakerRenderer.render([{ ...base, id: 1, x: 0, y: 0, z: 0, moveX: 1, moveMagnitude: 1 }, { ...base, id: 2, x: 1, y: 0, z: 0, moveX: 2, moveMagnitude: 2 }], { yaw: 0, pitch: Math.PI / 3, zoom: 1, panX: 0, panY: 0, pointScale: 1, showCylinders: false, smallBalls: false, noBalls: false, showNodes: true, showEllipses: false, showTransparentSpheres: false, showMovementVectors: true, showUnitMovement: false, showBox: false, showGrid: false, gridSpacing: 0, gridCount: 0 });
      return window.embryomakerRenderer.lastFrame;
    });
    if (movementVectorGeometry.movementVectors.length !== 2 || movementVectorGeometry.movementVectors[0].end[0] !== 10 || movementVectorGeometry.movementVectors[1].end[0] !== 21 || movementVectorGeometry.glError !== 0) throw new Error(`OG force vector maximum-length scale differs: ${JSON.stringify(movementVectorGeometry.movementVectors)}`);
    const forceOverlayGeometry = await page.evaluate(() => {
      const base = { type: 3, radius: .2, addRadius: .2, color: '#ff0000', visible: true, display: true, fixed: false, polx: 0, poly: 0, polz: 0 };
      const nodes = [
        { ...base, id: 1, x: 0, y: 0, z: 0, moveX: 1, moveY: 0, moveZ: 0, moveMagnitude: 1, repX: 1, repY: 0, repZ: 0, lateralX: 1, lateralY: 0, lateralZ: 0, axialX: 1, axialY: 0, axialZ: 0 },
        { ...base, id: 2, x: 1, y: 0, z: 0, moveX: 0, moveY: 2, moveZ: 0, moveMagnitude: 2, repX: 0, repY: 2, repZ: 0, lateralX: 0, lateralY: 2, lateralZ: 0, axialX: 0, axialY: 2, axialZ: 0 }
      ];
      const common = { yaw: 0, pitch: Math.PI / 3, zoom: 1, panX: 0, panY: 0, pointScale: 1, showCylinders: false, smallBalls: false, noBalls: true, showNodes: true, showEllipses: false, showTransparentSpheres: false, showBox: false, showGrid: false, gridSpacing: 0, gridCount: 0 };
      const cases = [
        ['unit movement', { showUnitMovement: true }, 4, 1, 1],
        ['movement module', { showMovementVectors: true }, 4, 10, 20],
        ['repulsion and adhesion', { showRepulsion: true }, 4, 1, 2],
        ['lateral epithelial tension', { showLateralForce: true }, 4, 1, 2],
        ['apical-basal epithelial tension', { showAxialForce: true }, 4, 1, 2]
      ];
      return cases.map(([name, options, expected, endpointX, maximumEndY]) => {
        window.embryomakerRenderer.render(nodes, { ...common, ...options });
        const frame = window.embryomakerRenderer.lastFrame;
        return { name, expected, endpointX, maximumEndY, lines: frame.underlayLineVertices, lineSamples: frame.underlayLineSamples, movementVectors: frame.movementVectors, glError: frame.glError };
      });
    });
    for (const overlay of forceOverlayGeometry) {
      if (overlay.lines !== overlay.expected || overlay.glError !== 0 || overlay.lineSamples.length !== 2 || overlay.lineSamples[0][0].some(value => value !== 0) || overlay.lineSamples[0][1][0] !== overlay.endpointX || overlay.lineSamples[0][1][1] !== 0 || overlay.lineSamples[0][1][2] !== 0 || overlay.lineSamples[1][1][1] !== overlay.maximumEndY) throw new Error(`OG ${overlay.name} vector mode produced the wrong geometry or scale: ${JSON.stringify(overlay)}`);
      if (overlay.name === 'movement module' && (overlay.movementVectors.length !== 2 || overlay.movementVectors[0].end[0] !== 10 || overlay.movementVectors[1].end[1] !== 20)) throw new Error(`OG movement module vectors have the wrong maximum-length scale: ${JSON.stringify(overlay)}`);
      if (overlay.name === 'unit movement' && overlay.movementVectors.length !== 0) throw new Error(`OG unit movement vectors were mixed with movement module vectors: ${JSON.stringify(overlay)}`);
    }
    const clippedPairGeometry = await page.evaluate(() => {
      const base = { radius: .2, addRadius: .2, color: '#ffffff', display: true, fixed: false };
      window.embryomakerRenderer.render([{...base,id:1,other:2,type:1,x:0,y:0,z:0,visible:true,arrowValue:.5},{...base,id:2,other:1,type:2,x:1,y:0,z:0,visible:false,display:false,arrowValue:0}],{yaw:0,pitch:Math.PI/3,zoom:1,panX:0,panY:0,pointScale:1,showCylinders:true,smallBalls:false,noBalls:false,showNodes:true,showEllipses:false,showTransparentSpheres:false,showArrows:true,arrowRange:[0,1],arrowScale:1,showBox:false,showGrid:false,gridSpacing:0,gridCount:0});
      return window.embryomakerRenderer.lastFrame;
    });
    if(clippedPairGeometry.triangleVertices<=0||clippedPairGeometry.arrowCount!==1||clippedPairGeometry.glError!==0)throw new Error(`OG section clipping lost the visible half-cylinder or its paired-node arrow: ${JSON.stringify(clippedPairGeometry)}`);
    await openMechanicalProperties(page);
    progress('opened mechanical arrow selector path');
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await page.locator('#ogMechanicalArrow').selectOption('scalar:eqd');
    progress('selected mechanical arrow property');
    await waitForNextRender(page, previousRender, 'Select OG arrow property');
    if (await page.evaluate(() => { const f=window.embryomakerRenderer.lastFrame; return f.arrowField==='scalar:eqd'&&f.showArrows; }) !== true) throw new Error('OG node arrow selection did not select and enable its property arrows');
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await openMechanicalProperties(page, 'arrow options');
    progress(`opened mechanical arrow options: ${JSON.stringify(await menuDiagnostics(page, '#ogMechanicalArrowScale'))}`);
    await page.locator('#ogMechanicalArrowMinimum').fill('-1');
    await page.locator('#ogMechanicalArrowMaximum').fill('2');
    await page.locator('#ogMechanicalArrowScale').fill('0.4');
    await page.locator('#ogMechanicalArrowScale').press('Tab');
    await waitForNextRender(page, previousRender, 'Set OG arrow range and scale');
    await page.waitForFunction(() => {const frame=window.embryomakerRenderer?.lastFrame;return frame?.arrowRange?.[0]===-1&&frame?.arrowRange?.[1]===2&&frame?.arrowScale===0.4;}, null, { timeout });
    const arrowSettings = await page.evaluate(() => window.embryomakerRenderer.lastFrame);
    if (arrowSettings.arrowRange[0] !== -1 || arrowSettings.arrowRange[1] !== 2 || arrowSettings.arrowScale !== 0.4) throw new Error(`OG arrow range or scale controls were not applied: ${JSON.stringify({range:arrowSettings.arrowRange,scale:arrowSettings.arrowScale})}`);
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    const disableArrowButton = page.locator('[data-menu="arrow-disable"]').first();
    try {
      await disableArrowButton.click();
    } catch (error) {
      const menuState = await page.evaluate(() => {
        const menu = document.querySelector('.classic-menu');
        const button = document.querySelector('[data-menu="arrow-disable"]');
        const rect = button?.getBoundingClientRect();
        return {
          menuHidden: menu?.hidden,
          menuClasses: menu?.className,
          openBranches: [...(menu?.querySelectorAll('details[open]') || [])].map(item => item.querySelector(':scope > summary')?.textContent.trim()),
          buttonRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
          buttonDisplay: button ? getComputedStyle(button).display : null,
          buttonVisibility: button ? getComputedStyle(button).visibility : null,
          activeElement: document.activeElement?.id || document.activeElement?.textContent?.trim()
        };
      });
      throw new Error(`OG arrow disable menu state failed: ${JSON.stringify(menuState)}; ${error.message}`);
    }
    await waitForNextRender(page, previousRender, 'Disable OG property arrows');
    await openMechanicalProperties(page, 'with semitransparent spheres');
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await page.locator('#ogMechanicalSphere').selectOption('scalar:eqd');
    await waitForNextRender(page, previousRender, 'Select OG sphere property');
    if (await page.evaluate(() => { const f=window.embryomakerRenderer.lastFrame; return f.sphereField==='scalar:eqd'&&f.showTransparentSpheres; }) !== true) throw new Error('OG transparent sphere selection did not select and enable its property spheres');
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await openMechanicalProperties(page, 'sphere options');
    await page.locator('#ogMechanicalSphereMinimum').fill('0');
    await page.locator('#ogMechanicalSphereMaximum').fill('2');
    await page.locator('#ogMechanicalSphereScale').fill('0.6');
    await page.locator('#ogMechanicalSphereScale').press('Tab');
    await waitForNextRender(page, previousRender, 'Set OG transparent sphere range and scale');
    await page.waitForFunction(() => {const frame=window.embryomakerRenderer?.lastFrame;return frame?.transparentRange?.[0]===0&&frame?.transparentRange?.[1]===2&&frame?.transparentScale===0.6;}, null, { timeout });
    const sphereSettings = await page.evaluate(() => window.embryomakerRenderer.lastFrame);
    if (sphereSettings.transparentRange[0] !== 0 || sphereSettings.transparentRange[1] !== 2 || sphereSettings.transparentScale !== 0.6) throw new Error(`OG transparent sphere range or scale controls were not applied: ${JSON.stringify({range:sphereSettings.transparentRange,scale:sphereSettings.transparentScale})}`);
    await openOtherProperties(page, 'with semitransparent spheres');
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await page.locator('#ogOtherSphere').selectOption('scalar:index');
    await waitForNextRender(page, previousRender, 'Select OG index sphere property');
    await openWhatToDraw(page);
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await page.locator('[data-menu="balls-none"]').click();
    await waitForNextRender(page, previousRender, 'Hide OG base balls for index spheres');
    await openWhatToDraw(page);
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await page.locator('[data-menu="balls-cylinders"]').click();
    await waitForNextRender(page, previousRender, 'Hide OG epithelial cylinders for index spheres');
    const indexSphereFrame = await page.evaluate(() => window.embryomakerRenderer.lastFrame);
    if (indexSphereFrame.sphereField !== 'scalar:index' || indexSphereFrame.transparentRange[0] !== 1 || indexSphereFrame.transparentRange[1] !== indexSphereFrame.visibleNodes || indexSphereFrame.transparentSphereCount <= 0 || indexSphereFrame.sphereInstances !== 0 || indexSphereFrame.canvasAlpha !== false) throw new Error(`OG index sphere overlay did not match the source range and display flags: ${JSON.stringify(indexSphereFrame)}`);
    await openWhatToDraw(page);
    await page.locator('[data-menu="balls-none"]').click();
    await openWhatToDraw(page);
    await page.locator('[data-menu="balls-cylinders"]').click();
    await openMechanicalProperties(page, 'sphere options');
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await page.locator('[data-menu="sphere-disable"]').first().click();
    await waitForNextRender(page, previousRender, 'Disable OG property spheres');
    const spatialOverlayGeometry = await page.evaluate(() => {
      const nodes = [
        { id: 1, other: 2, cell: 1, x: 0, y: 0, z: 0, x0: -.1, y0: 0, z0: 0, type: 1, radius: .2, addRadius: .2, color: '#ff0000', colorRGB: [.5, .25, .75], visible: true, display: true, fixed: false, polx: 0, poly: 0, polz: 0, moveX: 1, moveY: 0, moveZ: 0, moveMagnitude: 1, repX: 1, repY: 0, repZ: 0, lateralX: 1, lateralY: 0, lateralZ: 0, axialX: 1, axialY: 0, axialZ: 0 },
        { id: 2, other: 1, cell: 1, x: 1, y: 0, z: 0, x0: 1.1, y0: 0, z0: 0, type: 2, radius: .2, addRadius: .2, color: '#00ff00', visible: true, display: true, fixed: false, polx: 0, poly: 0, polz: 0, moveX: 0, moveY: 1, moveZ: 0, moveMagnitude: 1, repX: 0, repY: 1, repZ: 0, lateralX: 0, lateralY: 1, lateralZ: 0, axialX: 0, axialY: 1, axialZ: 0 }
      ];
      window.embryomakerRenderer.render(nodes, { yaw: 0, pitch: Math.PI / 3, zoom: 1, panX: 0, panY: 0, pointScale: 1, showCylinders: false, smallBalls: false, noBalls: false, showNodes: true, showEllipses: false, showTransparentSpheres: false, showCentroids: true, showPolarization: true, showSprings: true, showInterConnections: true, showIntraConnections: false, showDisplacement: true, showUnitMovement: true, showMovementVectors: false, showRepulsion: true, showLateralForce: true, showAxialForce: true, cells: [{ id: 1, x: .5, y: 0, z: 0, polx: 0, poly: 1, polz: 0, visible: true, display: false }], edges: [{ a: 1, b: 2, inter: true }], showBox: false, radiusMode: 'add', showGrid: false, gridSpacing: 0, gridCount: 0, bounds: { minx: -2, maxx: 2, miny: -2, maxy: 2, minz: -2, maxz: 2, spread: 4 }, showEggshell: true, eggshell: { points: [[0,0,0],[1,0,0],[0,1,0]], triangles: [[1,2,3]], colorMaximum: 1 }, slicePlots: [{ axis: 'x', plane: -1, samples: [{ position: [-1,0,0], value: 0 }, { position: [-1,1,0], value: 1 }] }] });
      return window.embryomakerRenderer.lastFrame;
    });
    if (spatialOverlayGeometry.nodeColorSamples[0].some((channel, i) => channel !== [.5, .25, .75][i])) throw new Error(`WebGL node colors lost their floating point ramp values: ${JSON.stringify(spatialOverlayGeometry.nodeColorSamples)}`);
    if (spatialOverlayGeometry.overlayLineVertices + spatialOverlayGeometry.underlayLineVertices < 20 || spatialOverlayGeometry.underlayLineVertices <= 0 || spatialOverlayGeometry.centroidInstances !== 1 || spatialOverlayGeometry.centroidDisplayRadius !== 0.01 || spatialOverlayGeometry.glError !== 0) throw new Error(`OG 3D line and centroid overlays failed: ${JSON.stringify(spatialOverlayGeometry)}`);
    const expectedSpatialRenderOrder = ['underlay-lines', 'eggshell', 'epithelial-springs', 'nodes', 'late-lines', 'slice-plots', 'centroids'];
    if (JSON.stringify(spatialOverlayGeometry.renderOrder) !== JSON.stringify(expectedSpatialRenderOrder)) throw new Error(`OG visualization layers rendered out of source order: ${JSON.stringify(spatialOverlayGeometry.renderOrder)}`);
    const expectedOgPipelineOrder = ['common-lines', 'eggshell', 'epithelial-springs', 'box-grid', 'node-loop', 'connections', 'slice-plots', 'cell-centroids'];
    if (JSON.stringify(spatialOverlayGeometry.ogPipelineOrder) !== JSON.stringify(expectedOgPipelineOrder)) throw new Error(`Flow renderer lost the OG draw_func stage contract: ${JSON.stringify(spatialOverlayGeometry.ogPipelineOrder)}`);
    if (spatialOverlayGeometry.eggshellTriangles !== 1 || spatialOverlayGeometry.slicePlotPoints !== 2 || spatialOverlayGeometry.glError !== 0) throw new Error(`OG eggshell or slice geometry failed: ${JSON.stringify(spatialOverlayGeometry)}`);
    const expectedOgStageOrder = ['common-lines', 'eggshell', 'epithelial-springs', 'node-loop', 'connections', 'slice-plots', 'cell-centroids'];
    if (JSON.stringify(spatialOverlayGeometry.ogStageOrder) !== JSON.stringify(expectedOgStageOrder)) throw new Error(`Flow renderer did not follow the OG draw_func stage order: ${JSON.stringify(spatialOverlayGeometry.ogStageOrder)}`);
    const generatedShellFrame = await page.evaluate(() => {
      const shell = window.embryomakerOgEggshell();
      window.embryomakerRenderer.render([], { yaw: 0, pitch: Math.PI / 3, zoom: 1, panX: 0, panY: 0, cameraDistance: 12, pointScale: 1, showBox: false, showGrid: false, showEggshell: true, eggshell: shell, cells: [], bounds: { minx: -1000000, maxx: 1000000, miny: -1000000, maxy: 1000000, minz: -1000000, maxz: 1000000, spread: 2000000 } });
      return { mesh: shell, frame: window.embryomakerRenderer.lastFrame };
    });
    if (generatedShellFrame.mesh.triangles.length !== 800 || generatedShellFrame.frame.eggshellMeshTriangles !== 800 || generatedShellFrame.frame.eggshellTriangles !== 800 || !generatedShellFrame.frame.ogStageOrder.includes('eggshell')) throw new Error(`Flow did not generate and draw the OG 20 by 20 eggshell mesh: ${JSON.stringify({ sourceTriangles: generatedShellFrame.mesh.triangles.length, renderedTriangles: generatedShellFrame.frame.eggshellTriangles, stages: generatedShellFrame.frame.ogStageOrder })}`);
    const elongationExamplePath = `${process.cwd()}/reference/examples/blastula-like_initial_conditions/Epithelial_blastula_filled_with_mesenchyme.dat`;
    let elongationInput = fs.readFileSync(elongationExamplePath, 'utf8');
    const effectSection = elongationInput.indexOf('E and C matrix:');
    if (effectSection < 0) throw new Error('Elongation parity fixture has no gene effect matrix');
    const effectRow = elongationInput.slice(effectSection).match(/^gen\s+1\s+([^\r\n]+)/m);
    if (!effectRow) throw new Error('Elongation parity fixture has no first gene row');
    const effectValues = effectRow[1].trim().split(/\s+/);
    if (effectValues.length !== 52) throw new Error(`Elongation parity fixture has ${effectValues.length} gene effects, expected 52`);
    effectValues[51] = '5.0000000000000000E-01';
    elongationInput = elongationInput.slice(0, effectSection) + elongationInput.slice(effectSection).replace(effectRow[0], `gen 1 ${effectValues.join(' ')}`);
    const elongationResponse = await page.request.post(apiUrl('/api/session'), { data: { inputText: elongationInput, fileName: 'elongation-parity-fixture.dat' } });
    if (!elongationResponse.ok()) throw new Error(`Custom elongation fixture returned ${elongationResponse.status()}`);
    const elongationModel = await elongationResponse.json();
    const expressionNode = elongationModel.nodes.find(node => node.genes?.[0] > 0);
    if (!expressionNode || !(expressionNode.elongationFactor > 1)) throw new Error(`Gene driven elongation was missing from the Flow model payload: ${JSON.stringify(expressionNode)}`);
    const polarizedResponse = await page.request.post(apiUrl(`/api/session/${elongationModel.session}/cell-edit`), { data: { cellId: expressionNode.cell, field: 'polx', value: 1 } });
    if (!polarizedResponse.ok()) throw new Error(`Polarized elongation fixture returned ${polarizedResponse.status()}`);
    const polarizedModel = await polarizedResponse.json();
    if (polarizedModel.cells.find(cell => cell.id === expressionNode.cell)?.polx !== 1) throw new Error('Elongation fixture cell polarization did not update');
    await page.request.post(apiUrl(`/api/session/${elongationModel.session}/close`), { data: {} });
    await openCameraMenu(page);
    await page.locator('[data-menu="drag-zoom"]').click();
    if (!(await page.locator('#zoomMode').evaluate(element => element.classList.contains('active')))) throw new Error('OG camera menu did not select left mouse zoom mode');
    await openCameraMenu(page);
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await page.locator('[data-menu="camera-reset"]').click();
    await waitForNextRender(page, previousRender, 'Reset to initial view');
    const resetCamera = await page.evaluate(() => window.embryomakerRenderer.lastFrame);
    if (resetCamera.cameraPitch !== 135 * Math.PI / 180 || resetCamera.zoom !== 1 || resetCamera.panX !== 0 || resetCamera.panY !== 0) throw new Error(`OG camera reset did not restore its configured view: ${JSON.stringify(resetCamera)}`);
    await openCameraMenu(page);
    await page.locator('[data-menu="drag-rotate"]').click();
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await dragStage(page, 10, 10);
    await waitForNextRender(page, previousRender, 'OG one degree per pixel camera rotation');
    const rotatedCamera = await page.evaluate(() => window.embryomakerRenderer.lastFrame);
    if (Math.abs(rotatedCamera.cameraYaw - Math.PI / 18) > 1e-6 || Math.abs(rotatedCamera.cameraPitch - (135 * Math.PI / 180 + Math.PI / 18)) > 1e-6) throw new Error(`Camera rotation differs from OG one degree per pixel behavior: ${JSON.stringify(rotatedCamera)}`);
    await openCameraMenu(page);
    await page.locator('[data-menu="drag-zoom"]').click();
    await dragStage(page, 0, 10);
    const zoomedCamera = await page.evaluate(() => window.embryomakerRenderer.lastFrame);
    if (Math.abs(zoomedCamera.zoom - 1 / 1.02) > 1e-6 || Math.abs(zoomedCamera.cameraDistance - 12.24) > 1e-6) throw new Error(`Camera zoom differs from OG 0.2 percent per pixel distance behavior: ${JSON.stringify(zoomedCamera)}`);
    await openCameraMenu(page);
    await page.locator('[data-menu="drag-pan"]').click();
    await dragStage(page, 10, 10);
    const pannedCamera = await page.evaluate(() => window.embryomakerRenderer.lastFrame);
    if (pannedCamera.panX !== 10 || pannedCamera.panY !== 10) throw new Error(`Camera pan differs from OG 0.01 units per pixel behavior: ${JSON.stringify(pannedCamera)}`);
    await openCameraMenu(page);
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await page.locator('[data-menu="camera-reset"]').click();
    await waitForNextRender(page, previousRender, 'Final camera reset');

    await selectOgExample(page, 'apical_contraction');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Model ready'), 'Reloading apical contraction');
    await page.locator('#stage').click({ position: { x: 410, y: 420 } });
    await page.waitForFunction(() => document.querySelector('#selectionInfo')?.textContent.startsWith('Node '), null, { timeout });
    const selectedNode = await page.locator('#selectionInfo').textContent();
    await openWhatToDraw(page);
    const ogRootMenus = await page.locator('.classic-menu > details > summary').allTextContents();
    const expectedRootMenus = ['Basic View Modifier', 'show node mechanical properties', 'show other node properties', 'what to draw', 'input output', 'Editor', 'selection menu', 'cursor menu', 'gene plotting options', 'move menu'];
    if (JSON.stringify(ogRootMenus) !== JSON.stringify(expectedRootMenus)) throw new Error(`Original EmbryoMaker root menu differs: ${JSON.stringify(ogRootMenus)}`);
    const ogRootActions = await page.locator('.classic-menu > button[data-menu]').allTextContents();
    const expectedRootActions = ['1 iteration', '100 iterations', '1000 iterations', '50000 iterations', 'x iterations', 'fitness', 'quit'];
    if (JSON.stringify(ogRootActions) !== JSON.stringify(expectedRootActions)) throw new Error(`Original EmbryoMaker root actions differ: ${JSON.stringify(ogRootActions)}`);
    await page.locator('.classic-menu summary').filter({ hasText: 'cursor menu' }).click();
    await page.locator('[data-menu="cursor-toggle"]').click();
    await page.waitForFunction(() => window.embryomakerRenderer?.lastFrame?.cursorInstances === 1, null, { timeout });
    if (await page.evaluate(() => window.embryomakerRenderer.lastFrame.cursorRadius) !== 0.3) throw new Error('OG cursor radius did not account for the original display scale');
    const cursorStart = await page.evaluate(() => window.embryomakerRenderer.lastFrame.cursorPosition);
    await openOgMenu(page);
    await page.locator('.classic-menu summary').filter({ hasText: 'cursor menu' }).click();
    await page.locator('[data-menu="cursor-xy"]').click();
    await dragStage(page, 6, 4);
    const cursorXY = await page.evaluate(() => window.embryomakerRenderer.lastFrame.cursorPosition);
    if (Math.abs(cursorXY[0] - cursorStart[0] - .06) > 1e-9 || Math.abs(cursorXY[1] - cursorStart[1] - .04) > 1e-9) throw new Error(`OG cursor movement did not follow the rotated view axes: ${JSON.stringify({cursorStart,cursorXY})}`);
    await openOgMenu(page);
    await page.locator('.classic-menu summary').filter({ hasText: 'cursor menu' }).click();
    await page.locator('[data-menu="cursor-z"]').click();
    await dragStage(page, 0, 5);
    const cursorZ = await page.evaluate(() => window.embryomakerRenderer.lastFrame.cursorPosition);
    if (Math.abs(cursorZ[2] - cursorXY[2] - .05) > 1e-9) throw new Error(`OG cursor Z movement had the wrong direction or scale: ${JSON.stringify({cursorXY,cursorZ})}`);
    await page.keyboard.press('ArrowDown');
    await dragStage(page, 6, 4);
    const keyboardCursorXY = await page.evaluate(() => window.embryomakerRenderer.lastFrame.cursorPosition);
    if (Math.abs(keyboardCursorXY[0] - cursorZ[0] - .06) > 1e-9 || Math.abs(keyboardCursorXY[1] - cursorZ[1] - .04) > 1e-9 || keyboardCursorXY[2] !== cursorZ[2]) throw new Error(`OG down-arrow cursor mode switch did not select x-y movement: ${JSON.stringify({cursorZ,keyboardCursorXY})}`);
    await page.keyboard.press('ArrowDown');
    await openOgMenu(page);
    await page.locator('.classic-menu summary').filter({ hasText: 'cursor menu' }).click();
    await page.locator('[data-menu="cursor-middle-z"]').click();
    await dragStage(page, 0, 5, 'middle');
    const cursorMiddleZ = await page.evaluate(() => window.embryomakerRenderer.lastFrame.cursorPosition);
    if (Math.abs(cursorMiddleZ[2] - cursorZ[2] - .05) > 1e-9) throw new Error(`OG middle mouse cursor movement had the wrong direction or scale: ${JSON.stringify({cursorZ,cursorMiddleZ})}`);
    await openOgMenu(page);
    await page.locator('.classic-menu summary').filter({ hasText: 'cursor menu' }).click();
    await page.locator('[data-menu="cursor-toggle"]').click();
    await page.waitForFunction(() => window.embryomakerRenderer?.lastFrame?.cursorInstances === 0, null, { timeout });
    await openOgMenu(page);
    await page.locator('.classic-menu summary').filter({ hasText: 'selection menu' }).click();
    await page.locator('[data-menu="select-node-cursor"]').click();
    await page.locator('#stage').click({ position: { x: 410, y: 420 } });
    await page.waitForFunction(() => window.embryomakerRenderer?.lastFrame?.cursorInstances === 1, null, { timeout });
    await clickOgAction(page, 'cursor menu', 'cursor-toggle');
    await page.waitForFunction(() => window.embryomakerRenderer?.lastFrame?.cursorInstances === 0, null, { timeout });
    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('1'));
    await page.locator('[data-menu="select-node-index"]').click();
    if (!(await page.locator('#selectionInfo').textContent()).startsWith('Node 1 ·')) throw new Error('OG select-node-by-index menu action did not select node 1');
    await openWhatToDraw(page);
    await page.locator('.classic-menu summary').filter({ hasText: 'selection menu' }).click();
    await page.locator('[data-menu="undo-selections"]').click();
    if ((await page.locator('#selectionInfo').textContent()) !== selectedNode) throw new Error('OG undo-selections menu action did not restore the previous node');
    await openOgCategory(page, 'Editor');
    if (!(await page.locator('#nodeEditControls').isVisible()) || !(await page.locator('#cellEditControls').isVisible())) throw new Error('OG Editor menu did not expose node and cell property controls');
    await page.locator('#nodeProperty').selectOption('energy');
    await page.locator('#applyNodeEdit').click();
    await waitForStatus(page, () => document.querySelector('#status .message')?.startsWith?.('Updated node ') || document.querySelector('#status .message')?.textContent.startsWith('Updated node '), 'Original menu node property edit');
    await page.evaluate(() => document.querySelector('#stepBtn').click());
    await waitForStatus(page, () => document.querySelector('#iterationValue')?.textContent === '1', 'Apical contraction solver step 1');
    await page.evaluate(() => document.querySelector('#stepBtn').click());
    const degenerateStatus = await waitForStatus(page,
      () => document.querySelector('#status .message')?.textContent.includes('Delaunay status 301'),
      'Apical contraction degenerate triangulation recovery');
    const fixedBoundsBefore = await page.evaluate(() => window.embryomakerRenderer.lastFrame.sceneBounds);
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await clickOgAction(page, 'Basic View Modifier', 'fixed-sections-toggle');
    await waitForNextRender(page, previousRender, 'Enable fixed sections');
    if (!(await page.evaluate(() => window.embryomakerRenderer.lastFrame.fixedSections))) throw new Error('OG fixed section mode did not turn on');
    await page.evaluate(() => document.querySelector('#stepBtn').click());
    await waitForNextRender(page, previousRender, 'Fixed section solver step');
    const fixedBoundsAfter = await page.evaluate(() => window.embryomakerRenderer.lastFrame.sceneBounds);
    if (JSON.stringify(fixedBoundsAfter) !== JSON.stringify(fixedBoundsBefore)) throw new Error(`OG fixed section bounds changed during an iteration: ${JSON.stringify({ fixedBoundsBefore, fixedBoundsAfter })}`);
    previousRender = await page.evaluate(() => window.embryomakerRenderer.lastFrame.serial);
    await clickOgAction(page, 'Basic View Modifier', 'fixed-sections-toggle');
    await page.waitForFunction(serial => { const frame=window.embryomakerRenderer?.lastFrame; return frame?.serial>serial&&!frame.fixedSections; }, previousRender, { timeout });
    if (await page.evaluate(() => window.embryomakerRenderer.lastFrame.fixedSections)) throw new Error('OG fixed section mode did not turn off');
    await selectOgExample(page, 'migration');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Model ready'), 'Reloading migration');
    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('1'));
    await page.locator('[data-menu="select-node-index"]').click();
    await openOgMenu(page);
    await page.locator('.classic-menu summary').filter({ hasText: 'move menu' }).click();
    const keepCellCoordinates = dialog => dialog.accept('-1');
    page.on('dialog', keepCellCoordinates);
    await page.locator('[data-menu="move-cell-terminal"]').click();
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Moved cell '), 'Original menu terminal cell movement');
    page.off('dialog', keepCellCoordinates);
    await openOgMenu(page);
    await page.locator('.classic-menu summary').filter({ hasText: 'move menu' }).click();
    await page.locator('[data-menu="move-cell-mouse"]').click();
    await dragStage(page, 2, 0);
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Moved cell '), 'Original menu mouse cell movement');
    await clickOgAction(page, 'move menu', 'move-node-mouse');
    await dragStage(page, 1, 1);
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Moved node '), 'Original menu mouse node movement');
    await clickOgAction(page, 'input output', 'reset-model');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Model ready at iteration 0.', 'Reset after OG cell movement');
    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('1'));
    await page.locator('[data-menu="select-node-index"]').click();
    await openOgMenu(page);
    await page.locator('.classic-menu summary').filter({ hasText: 'gene plotting options' }).click();
    await page.evaluate(() => document.querySelector('#stepBtn').click());
    await waitForStatus(page, () => document.querySelector('#iterationValue')?.textContent === '1', 'Temporal gene solver step');
    await openOgMenu(page);
    await page.locator('.classic-menu summary').filter({ hasText: 'gene plotting options' }).click();
    let plotPromptIndex = 0;
    const acceptPlotSelection = dialog => dialog.accept(plotPromptIndex++ === 0 ? '1,2' : '1');
    page.on('dialog', acceptPlotSelection);
    await page.locator('[data-menu="plot-gene"]').click();
    await page.waitForFunction(() => { const panel=document.querySelector('#genePlotPanel'); return panel && !panel.hidden && Number(panel.dataset.samples)>=2 && Number(panel.dataset.series)===2; }, null, { timeout });
    const genePlotLegend = await page.locator('#genePlotLegend').innerText();
    if (!genePlotLegend.includes('Node 1, gene 1') || !genePlotLegend.includes('Node 2, gene 1')) throw new Error(`OG gene plot did not include both requested node histories: ${genePlotLegend}`);
    page.off('dialog', acceptPlotSelection);
    await page.locator('#genePlotClose').click();
    await page.waitForFunction(() => document.querySelector('#genePlotPanel')?.hidden, null, { timeout });
    await openOgMenu(page);
    await page.locator('.classic-menu summary').filter({ hasText: 'gene plotting options' }).click();
    await page.locator('[data-menu="temporal-plots-toggle"]').click();
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Temporal plot collection paused.', 'Pause temporal plot collection');
    await clickOgAction(page, 'gene plotting options', 'temporal-plots-toggle');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Temporal plot collection resumed.', 'Resume temporal plot collection');
    await clickOgAction(page, 'input output', 'reset-model');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Model ready at iteration 0.', 'Reset');
    await openWhatToDraw(page);
    await page.locator('[data-menu="iterate-1"]').click();
    await waitForStatus(page, () => document.querySelector('#iterationValue')?.textContent === '1', 'Original menu 1 solver iteration');
    await clickOgAction(page, 'input output', 'reset-model');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Model ready at iteration 0.', 'Reset after menu iteration');

    await openOgCategory(page, 'input output');
    await page.locator('#snapshotFrequency').fill('1');
    await page.locator('#outputLabel').fill(smokeOutputPrefix);
    await page.locator('[data-menu="periodic-toggle"]').click();
    await clickOgAction(page, 'what to draw', 'iterate-1');
    const periodicSnapshotStatus = await waitForStatus(page, () => /Saved iteration \d+ to output\/Migration\/UiSmokeParity[^/]*_\d+\.dat\./.test(document.querySelector('#status .message')?.textContent || ''), 'OG periodic snapshot');
    const periodicSnapshotPath = periodicSnapshotStatus.match(/output\/Migration\/UiSmokeParity[^/]*_\d+\.dat/)?.[0];
    if (!periodicSnapshotPath || !fs.existsSync(periodicSnapshotPath) || fs.statSync(periodicSnapshotPath).size < 1000) throw new Error(`Periodic snapshot was not written to the original output tree: ${periodicSnapshotStatus}`);
    fs.unlinkSync(periodicSnapshotPath);
    await clickOgAction(page, 'input output', 'periodic-toggle');
    await clickOgAction(page, 'input output', 'export');
    const presentSnapshotStatus = await waitForStatus(page, () => /Saved iteration \d+ to output\/Migration\/UiSmokeParity[^/]*_\d+\.dat\./.test(document.querySelector('#status .message')?.textContent || ''), 'OG save present time');
    if (!fs.existsSync(periodicSnapshotPath) || fs.statSync(periodicSnapshotPath).size < 1000) throw new Error(`Save-present-time did not write its snapshot: ${presentSnapshotStatus}`);
    fs.unlinkSync(periodicSnapshotPath);
    await clickOgAction(page, 'input output', 'reset-model');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Model ready at iteration 0.', 'Reset before automatic image output');
    await clickOgAction(page, 'input output', 'images-toggle');
    await clickOgAction(page, 'what to draw', 'iterate-1');
    const imageStatus = await waitForStatus(page, () => /Saved image for iteration \d+ to images\/Migration\/UiSmokeParity[^/]*_\d+\.png\./.test(document.querySelector('#status .message')?.textContent || ''), 'OG automatic image output');
    const imagePath = imageStatus.match(/images\/Migration\/UiSmokeParity[^/]*_\d+\.png/)?.[0];
    if (!imagePath || !fs.existsSync(imagePath) || fs.readFileSync(imagePath).subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Automatic image output is not a PNG in the original image tree: ${imageStatus}`);
    fs.unlinkSync(imagePath);
    await clickOgAction(page, 'input output', 'images-toggle');
    await clickOgAction(page, 'input output', 'reset-model');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Model ready at iteration 0.', 'Reset after output checks');
    page.once('dialog', dialog => dialog.accept('2'));
    await clickOgAction(page, 'input output', 'movie-toggle');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Movie recording through iteration 2.', 'OG movie capture start');
    await clickOgAction(page, 'what to draw', 'iterate-1');
    await page.waitForFunction(() => !document.querySelector('#runBtn')?.disabled, null, { timeout });
    await clickOgAction(page, 'what to draw', 'iterate-1');
    const movieStatus = await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.includes('Saved movie to output/Migration/UiSmokeParity'), 'OG movie GIF output');
    const moviePath = movieStatus.match(/output\/Migration\/UiSmokeParity[^/]*_[A-Za-z0-9_]+\.gif/)?.[0];
    if (!moviePath || !fs.existsSync(moviePath) || !['GIF87a','GIF89a'].includes(fs.readFileSync(moviePath).subarray(0, 6).toString())) throw new Error(`Movie output is not a GIF in the original output tree: ${movieStatus}`);
    fs.unlinkSync(moviePath);
    await page.waitForFunction(() => !document.querySelector('#runBtn')?.disabled, null, { timeout });
    await clickOgAction(page, 'input output', 'reset-model');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Model ready at iteration 0.', 'Reset after movie capture');

    await dragStage(page, 9, 4);
    const cameraBeforeKeyboard = await page.evaluate(() => ({ yaw: window.embryomakerRenderer.lastFrame.cameraYaw, pitch: window.embryomakerRenderer.lastFrame.cameraPitch, zoom: window.embryomakerRenderer.lastFrame.zoom, panX: window.embryomakerRenderer.lastFrame.panX, panY: window.embryomakerRenderer.lastFrame.panY }));
    await page.locator('#stage').click({ position: { x: 5, y: 5 } });
    const iterationBeforeRight = Number(await page.locator('#iterationValue').textContent());
    await page.keyboard.press('ArrowRight');
    await waitForStatus(page, previous => Number(document.querySelector('#iterationValue')?.textContent) === previous + 1, 'OG right-arrow single solver iteration', iterationBeforeRight);
    const keyboardAfterRight = Number(await page.locator('#iterationValue').textContent());
    const modelForBatchCheck = await readCurrentModel(page);
    let arrowUpRequest = null, completeArrowUp;
    const arrowUpCompleted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ArrowUp did not send the expected ten-unit request: ${JSON.stringify(arrowUpRequest)}`)), timeout);
      completeArrowUp = () => { clearTimeout(timer); resolve(); };
    });
    await page.route(`**/api/session/${modelForBatchCheck.session}/advance`, async route => {
      const body = route.request().postDataJSON();
      if (body.steps === 10) {
        arrowUpRequest = body;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...modelForBatchCheck, iterations: modelForBatchCheck.iterations + 10 }) });
        completeArrowUp();
      } else await route.continue();
    });
    await page.keyboard.press('ArrowUp');
    await arrowUpCompleted;
    await page.unroute(`**/api/session/${modelForBatchCheck.session}/advance`);
    if (!arrowUpRequest || arrowUpRequest.steps !== 10) throw new Error(`OG up-arrow did not request ten solver iterations: ${JSON.stringify(arrowUpRequest)}`);
    await page.waitForFunction(() => !document.querySelector('#runBtn')?.disabled, null, { timeout });
    const keyboardAfterUp = Number(await page.locator('#iterationValue').textContent());
    if (keyboardAfterUp !== keyboardAfterRight + 10) throw new Error(`OG up-arrow advanced ${keyboardAfterUp - keyboardAfterRight} solver iterations instead of ten`);
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(target => Number(document.querySelector('#iterationValue')?.textContent) === target, keyboardAfterUp - 1, { timeout });
    const cameraAfterRewind = await page.evaluate(() => ({ yaw: window.embryomakerRenderer.lastFrame.cameraYaw, pitch: window.embryomakerRenderer.lastFrame.cameraPitch, zoom: window.embryomakerRenderer.lastFrame.zoom, panX: window.embryomakerRenderer.lastFrame.panX, panY: window.embryomakerRenderer.lastFrame.panY }));
    if (Object.keys(cameraBeforeKeyboard).some(key => Math.abs(cameraBeforeKeyboard[key] - cameraAfterRewind[key]) > 1e-9)) throw new Error(`OG rewind changed the current camera: ${JSON.stringify({cameraBeforeKeyboard,cameraAfterRewind})}`);
    await clickOgAction(page, 'input output', 'reset-model');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Model ready at iteration 0.', 'Reset after OG keyboard iteration commands');

    await clickOgAction(page, 'what to draw', 'iterate-1');
    await waitForStatus(page, () => document.querySelector('#iterationValue')?.textContent === '1', 'Original menu single solver iteration');
    await clickOgAction(page, 'input output', 'reset-model');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Model ready at iteration 0.', 'Reset before basic-cell parity checks');

    let cellAddResponse = page.waitForResponse(response => response.url().includes('/cell-add') && response.request().method() === 'POST');
    await clickOgAction(page, 'Editor', 'editor-add-basic-epithelial');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Added a basic epithelial cell'), 'OG basic epithelial cell addition');
    let addedCellModel = await (await cellAddResponse).json();
    let addedCell = addedCellModel.cells.at(-1);
    let addedNodes = addedCellModel.nodes.filter(node => node.cell === addedCell.id);
    if (addedNodes.length !== 14 || addedCell.type !== 1 || addedNodes.filter(node => node.type === 1).length !== 7 || addedNodes.filter(node => node.type === 2).length !== 7) throw new Error(`OG basic epithelial cell shape mismatch: ${JSON.stringify({ cell: addedCell, nodes: addedNodes.length, types: addedNodes.reduce((counts,node) => (counts[node.type]=(counts[node.type]||0)+1,counts),{}) })}`);
    for (const node of addedNodes) {
      const partner = addedCellModel.nodes[node.other - 1];
      if (!partner || partner.cell !== addedCell.id || partner.other !== node.id || Math.abs(Math.abs(partner.z - node.z) - 0.5) > 1e-9) throw new Error(`OG epithelial node pairing or layer spacing mismatch at node ${node.id}`);
    }
    for (let ring = 0; ring < 7; ring++) {
      const node = addedNodes[ring];
      const angle = ring === 0 ? 0 : (ring - 1) * Math.PI / 3;
      const upper = addedNodes[ring + 7];
      if (Math.abs(upper.x - node.x) > 1e-9 || Math.abs(upper.y - node.y) > 1e-9 || Math.abs((upper.z + node.z) / 2 - (node.z + 0.25)) > 1e-9) throw new Error(`OG epithelial layer coordinates mismatch at ring node ${ring + 1}`);
      if (ring > 0 && (Math.abs(node.x - (addedCellModel.nodes[addedNodes[0].other - 1].x + 0.5 + 0.5 * Math.cos(angle))) > 1e-9 || Math.abs(node.y - (addedCellModel.nodes[addedNodes[0].other - 1].y + 0.5 * Math.sin(angle))) > 1e-9)) throw new Error(`OG epithelial ring coordinates mismatch at ring node ${ring + 1}`);
    }
    const editorBasicEpithelialCell = { nodes: addedNodes.length, cellType: addedCell.type, pairedNodes: addedNodes.every(node => addedCellModel.nodes[node.other - 1]?.other === node.id) };

    await clickOgAction(page, 'input output', 'reset-model');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Model ready at iteration 0.', 'Reset before mesenchymal cell parity check');
    cellAddResponse = page.waitForResponse(response => response.url().includes('/cell-add') && response.request().method() === 'POST');
    await clickOgAction(page, 'Editor', 'editor-add-basic-mesenchymal');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Added a basic mesenchymal cell'), 'OG basic mesenchymal cell addition');
    addedCellModel = await (await cellAddResponse).json();
    addedCell = addedCellModel.cells.at(-1);
    addedNodes = addedCellModel.nodes.filter(node => node.cell === addedCell.id);
    if (addedNodes.length !== 14 || addedCell.type !== 3 || addedCell.time !== 2 || addedNodes.some(node => node.type !== 3 || node.other !== 0)) throw new Error(`OG basic mesenchymal cell conversion mismatch: ${JSON.stringify({ cell: addedCell, nodes: addedNodes.length, types: [...new Set(addedNodes.map(node => node.type))], partners: addedNodes.filter(node => node.other !== 0).length })}`);
    for (let ring = 0; ring < 7; ring++) {
      const lower = addedNodes[ring], upper = addedNodes[ring + 7];
      const gap = Math.hypot(lower.x - upper.x, lower.y - upper.y, lower.z - upper.z);
      if (Math.abs(gap - 0.2 * (lower.radius + upper.radius)) > 1e-8 || Math.abs(lower.x - upper.x) > 1e-9 || Math.abs(lower.y - upper.y) > 1e-9) throw new Error(`OG mesenchymal EMT pair spacing mismatch at ring node ${ring + 1}: ${gap}`);
    }
    const editorBasicMesenchymalCell = { nodes: addedNodes.length, cellType: addedCell.type, transition: addedCell.time, unpairedNodes: addedNodes.every(node => node.other === 0) };

    await page.evaluate(() => document.querySelector('#stepBtn').click());
    await waitForStatus(page, () => document.querySelector('#iterationValue')?.textContent === '1', 'Simulation step after basic mesenchymal cell addition');

    await clickOgAction(page, 'input output', 'reset-model');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Model ready at iteration 0.', 'Reset after basic-cell parity checks');

    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('1'));
    await page.locator('[data-menu="select-node-index"]').click();
    const geneEditResponse = page.waitForResponse(response => response.url().includes('/gene-edit') && response.request().method() === 'POST');
    let genePromptIndex = 0;
    const answerGenePrompts = dialog => { void dialog.accept(genePromptIndex++ === 0 ? '1' : '2.5'); };
    page.on('dialog', answerGenePrompts);
    await clickOgAction(page, 'Editor', 'editor-change-gene');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Changed gene 1 expression in node 1.', 'OG selected-node gene expression edit');
    page.off('dialog', answerGenePrompts);
    const geneEditedModel = await (await geneEditResponse).json();
    if (geneEditedModel.nodes[0].genes[0] !== 2.5) throw new Error(`OG selected-node gene edit returned ${geneEditedModel.nodes[0].genes[0]}, expected 2.5`);
    const editorGeneEdit = { node: 1, gene: 1, value: geneEditedModel.nodes[0].genes[0] };
    await clickOgAction(page, 'input output', 'reset-model');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Model ready at iteration 0.', 'Reset after selected-node gene edit');

    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('1'));
    await page.locator('[data-menu="select-node-index"]').click();
    await openOgCategory(page, 'Editor');
    await page.locator('#nodeProperty').selectOption('you');
    await page.locator('#nodeValue').fill('2.5');
    await page.locator('#applyNodeEdit').click();
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Updated node 1.', 'Set source node property');
    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('2'));
    await page.locator('[data-menu="select-node-index"]').click();
    await openOgCategory(page, 'Editor');
    await page.locator('#nodeProperty').selectOption('you');
    await page.locator('#nodeValue').fill('0.5');
    await page.locator('#applyNodeEdit').click();
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Updated node 2.', 'Set target node property');
    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('1'));
    await page.locator('[data-menu="select-node-index"]').click();
    await openOgCategory(page, 'Editor');
    await page.locator('#nodeProperty').selectOption('you');
    await clickOgAction(page, 'Editor', 'editor-copy-node-property');
    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('2'));
    await page.locator('[data-menu="select-node-index"]').click();
    const nodePropertyPasteResponse = page.waitForResponse(response => response.url().endsWith('/edit') && response.request().method() === 'POST');
    await clickOgAction(page, 'Editor', 'editor-paste-node-property');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Pasted you onto node 2.', 'OG selected-node property paste');
    let propertyModel = await (await nodePropertyPasteResponse).json();
    if (propertyModel.nodes[1].you !== 2.5) throw new Error(`OG node property paste returned ${propertyModel.nodes[1].you}, expected 2.5`);
    const editorNodePropertyPaste = { source: 1, target: 2, field: 'you', value: propertyModel.nodes[1].you };

    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('1'));
    await page.locator('[data-menu="select-cell-index"]').click();
    await openOgCategory(page, 'Editor');
    await page.locator('#cellProperty').selectOption('polx');
    await page.locator('#cellValue').fill('1.25');
    await page.locator('#applyCellEdit').click();
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Updated cell 1.', 'Set source cell property');
    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('2'));
    await page.locator('[data-menu="select-cell-index"]').click();
    await openOgCategory(page, 'Editor');
    await page.locator('#cellProperty').selectOption('polx');
    await page.locator('#cellValue').fill('-0.75');
    await page.locator('#applyCellEdit').click();
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Updated cell 2.', 'Set target cell property');
    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('1'));
    await page.locator('[data-menu="select-cell-index"]').click();
    await openOgCategory(page, 'Editor');
    await page.locator('#cellProperty').selectOption('polx');
    await clickOgAction(page, 'Editor', 'editor-copy-cell-property');
    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('2'));
    await page.locator('[data-menu="select-cell-index"]').click();
    const cellPropertyPasteResponse = page.waitForResponse(response => response.url().endsWith('/cell-edit') && response.request().method() === 'POST');
    await clickOgAction(page, 'Editor', 'editor-paste-cell-property');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent === 'Pasted polx onto cell 2.', 'OG selected-cell property paste');
    propertyModel = await (await cellPropertyPasteResponse).json();
    if (propertyModel.cells[1].polx !== 1.25) throw new Error(`OG cell property paste returned ${propertyModel.cells[1].polx}, expected 1.25`);
    const editorCellPropertyPaste = { source: 1, target: 2, field: 'polx', value: propertyModel.cells[1].polx };

    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('1'));
    await page.locator('[data-menu="select-node-index"]').click();
    const nodesBeforeEditorPaste = Number(await page.locator('#nodeCount').textContent());
    const pasteResponse = page.waitForResponse(response => response.url().includes('/node-paste') && response.request().method() === 'POST');
    await clickOgAction(page, 'Editor', 'editor-paste-node');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Pasted node 1'), 'OG editor selected-node paste');
    const pastedModel = await (await pasteResponse).json();
    const pastedNodes = pastedModel.nodes.slice(-2), pastedSource = pastedModel.nodes[0], pastedPartner = pastedModel.nodes[pastedSource.other - 1];
    if (pastedModel.nodes.length !== nodesBeforeEditorPaste + 2 || pastedNodes.length !== 2 || pastedNodes[0].type !== pastedSource.type || pastedNodes[1].type !== pastedPartner.type || pastedNodes[0].other !== pastedNodes[1].id || pastedNodes[1].other !== pastedNodes[0].id || JSON.stringify(pastedNodes[0].genes) !== JSON.stringify(pastedSource.genes) || Math.abs(pastedNodes[0].radius - pastedSource.radius) > 1e-12) throw new Error(`OG selected epithelial node paste did not preserve source properties and pairing: ${JSON.stringify({ before: nodesBeforeEditorPaste, after: pastedModel.nodes.length, pastedNodes })}`);
    const editorNodePaste = { before: nodesBeforeEditorPaste, after: pastedModel.nodes.length, copiedGenes: true, paired: true };

    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('1'));
    await page.locator('[data-menu="select-cell-index"]').click();
    const cellsBeforeEditorPaste = Number(await page.locator('#cellCount').textContent());
    const nodesBeforeEditorCellPaste = Number(await page.locator('#nodeCount').textContent());
    const cellPasteResponse = page.waitForResponse(response => response.url().includes('/cell-paste') && response.request().method() === 'POST');
    await clickOgAction(page, 'Editor', 'editor-paste-cell');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Pasted cell 1'), 'OG editor selected-cell paste');
    const pastedCellModel = await (await cellPasteResponse).json();
    const sourceCellNodes = pastedCellModel.nodes.filter(node => node.cell === 1);
    const pastedCell = pastedCellModel.cells.at(-1);
    const copiedCellNodes = pastedCellModel.nodes.filter(node => node.cell === pastedCell.id);
    if (pastedCellModel.cells.length !== cellsBeforeEditorPaste + 1 || pastedCellModel.nodes.length !== nodesBeforeEditorCellPaste + sourceCellNodes.length || copiedCellNodes.length !== sourceCellNodes.length || pastedCell.type !== pastedCellModel.cells[0].type) throw new Error(`OG selected cell paste count or type mismatch: ${JSON.stringify({ sourceNodes: sourceCellNodes.length, copiedNodes: copiedCellNodes.length, cells: pastedCellModel.cells.length })}`);
    let cellShift = null;
    for (const candidate of sourceCellNodes.filter(node => node.type === copiedCellNodes[0].type && node.radius === copiedCellNodes[0].radius && JSON.stringify(node.genes) === JSON.stringify(copiedCellNodes[0].genes))) {
      const shift = [copiedCellNodes[0].x - candidate.x, copiedCellNodes[0].y - candidate.y, copiedCellNodes[0].z - candidate.z];
      const mapsWholeCell = copiedCellNodes.every(copy => sourceCellNodes.some(source => source.type === copy.type && source.radius === copy.radius && JSON.stringify(source.genes) === JSON.stringify(copy.genes) && Math.abs(copy.x - source.x - shift[0]) < 1e-9 && Math.abs(copy.y - source.y - shift[1]) < 1e-9 && Math.abs(copy.z - source.z - shift[2]) < 1e-9));
      if (mapsWholeCell) { cellShift = shift; break; }
    }
    if (!cellShift) throw new Error('OG selected cell paste did not preserve a translated copy of the source geometry');
    for (const copiedNode of copiedCellNodes) {
      const sourceNode = sourceCellNodes.find(candidate => Math.abs(copiedNode.x - candidate.x - cellShift[0]) < 1e-9 && Math.abs(copiedNode.y - candidate.y - cellShift[1]) < 1e-9 && Math.abs(copiedNode.z - candidate.z - cellShift[2]) < 1e-9);
      const mismatch = !sourceNode || copiedNode.type !== sourceNode.type || copiedNode.radius !== sourceNode.radius || JSON.stringify(copiedNode.genes) !== JSON.stringify(sourceNode.genes) || copiedNode.other < 1 || pastedCellModel.nodes[copiedNode.other - 1]?.cell !== pastedCell.id;
      if (mismatch) throw new Error(`OG selected cell paste did not preserve node state at copied node ${copiedNode.id}: ${JSON.stringify({ sourceNode, copiedNode, cellShift })}`);
    }
    const editorCellPaste = { nodes: copiedCellNodes.length, cellType: pastedCell.type, copiedGenes: true, preservedShape: true };

    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('1'));
    await page.locator('[data-menu="select-node-index"]').click();
    const nodesBeforeEditorAdd = Number(await page.locator('#nodeCount').textContent());
    await clickOgAction(page, 'Editor', 'editor-add-node');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Added a node to cell '), 'OG editor epithelial node addition');
    const nodesAfterEditorAdd = Number(await page.locator('#nodeCount').textContent());
    if (nodesAfterEditorAdd !== nodesBeforeEditorAdd + 2) throw new Error(`OG epithelial node addition changed node count from ${nodesBeforeEditorAdd} to ${nodesAfterEditorAdd}, expected a paired addition`);
    const editorNodeAddition = { before: nodesBeforeEditorAdd, after: nodesAfterEditorAdd };
    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('1'));
    await page.locator('[data-menu="select-node-index"]').click();
    const nodesBeforeEditorDelete = Number(await page.locator('#nodeCount').textContent());
    const cellsBeforeEditorDelete = Number(await page.locator('#cellCount').textContent());
    await clickOgAction(page, 'Editor', 'editor-delete-node');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Deleted node '), 'OG editor node deletion');
    const nodesAfterEditorDelete = Number(await page.locator('#nodeCount').textContent());
    if (nodesAfterEditorDelete >= nodesBeforeEditorDelete || Number(await page.locator('#cellCount').textContent()) !== cellsBeforeEditorDelete) throw new Error('OG Editor node deletion did not remove the selected node and its pair while preserving the cell');
    const editorNodeDeletion = { before: nodesBeforeEditorDelete, after: nodesAfterEditorDelete, cells: cellsBeforeEditorDelete };
    await openOgCategory(page, 'selection menu');
    page.once('dialog', dialog => dialog.accept('1'));
    await page.locator('[data-menu="select-cell-index"]').click();
    const cellsBeforeCellDelete = Number(await page.locator('#cellCount').textContent());
    const nodesBeforeCellDelete = Number(await page.locator('#nodeCount').textContent());
    await clickOgAction(page, 'Editor', 'editor-delete-cell');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Deleted cell '), 'OG editor cell deletion');
    if (Number(await page.locator('#cellCount').textContent()) !== cellsBeforeCellDelete - 1 || Number(await page.locator('#nodeCount').textContent()) >= nodesBeforeCellDelete) throw new Error('OG Editor cell deletion did not remove the selected cell and its nodes');
    const editorCellDeletion = { nodesBefore: nodesBeforeCellDelete, nodesAfter: Number(await page.locator('#nodeCount').textContent()), cellsBefore: cellsBeforeCellDelete, cellsAfter: Number(await page.locator('#cellCount').textContent()) };

    const nodesBeforeEcmAdd = Number(await page.locator('#nodeCount').textContent());
    await clickOgAction(page, 'Editor', 'editor-add-ecm');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Added an extracellular node'), 'OG editor ECM node addition');
    const nodesAfterEcmAdd = Number(await page.locator('#nodeCount').textContent());
    if (nodesAfterEcmAdd !== nodesBeforeEcmAdd + 1) throw new Error(`OG editor ECM node addition changed node count from ${nodesBeforeEcmAdd} to ${nodesAfterEcmAdd}`);
    const editorEcmAddition = { before: nodesBeforeEcmAdd, after: nodesAfterEcmAdd };

    await page.locator('#filePicker').setInputFiles(`${process.cwd()}/reference/examples/apoptosis/apoptosis.txt`);
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Model ready at iteration 0'), 'Load custom EmbryoMaker input');
    const customInput = await page.evaluate(() => ({
      fileName: document.querySelector('#uploadLabel')?.textContent,
      nodeCount: Number(document.querySelector('#nodeCount')?.textContent.replace(/,/g, '')),
      frame: window.embryomakerRenderer?.lastFrame
    }));
    if (customInput.fileName !== 'apoptosis.txt' || customInput.nodeCount !== 518 || customInput.frame?.visibleNodes !== 518 || customInput.frame?.glError !== 0) {
      throw new Error(`Custom EmbryoMaker input did not load and render: ${JSON.stringify(customInput)}`);
    }
    expectingInvalidInputRejection = true;
    await page.locator('#filePicker').setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid EmbryoMaker input') });
    const invalidInputStatus = await waitForStatus(page,
      () => document.querySelector('#status .message')?.textContent.includes('Could not load EmbryoMaker input'),
      'Reject invalid custom input');
    expectingInvalidInputRejection = false;
    if (Number((await page.locator('#nodeCount').textContent()).replace(/,/g, '')) !== 518) throw new Error('Rejecting a custom input discarded the last rendered model.');
    await page.evaluate(() => document.querySelector('#stepBtn').click());
    await waitForStatus(page, () => document.querySelector('#iterationValue')?.textContent === '1', 'Advance after rejecting invalid custom input');
    if (Number((await page.locator('#nodeCount').textContent()).replace(/,/g, '')) !== 518) throw new Error('Rejecting a custom input corrupted the active Flow simulation.');
    await page.locator('#filePicker').setInputFiles(`${process.cwd()}/reference/examples/apoptosis/apoptosis.txt`);
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Model ready at iteration 0'), 'Recover after invalid custom input');

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileGeometry = await page.locator('#stage').evaluate(canvas => {
      const rect = canvas.getBoundingClientRect();
      const parent = canvas.parentElement.getBoundingClientRect();
      return { width: rect.width, height: rect.height, left: rect.left - parent.left, top: rect.top - parent.top, parentWidth: parent.width, parentHeight: parent.height };
    });
    if (mobileGeometry.width <= 0 || Math.abs(mobileGeometry.width - mobileGeometry.height) > 2 || mobileGeometry.left < 0 || mobileGeometry.top < 0 || mobileGeometry.left + mobileGeometry.width > mobileGeometry.parentWidth + 1 || mobileGeometry.top + mobileGeometry.height > mobileGeometry.parentHeight + 1) {
      throw new Error(`Narrow viewport clips or distorts the OG square visualization: ${JSON.stringify(mobileGeometry)}`);
    }

    const retinaGeometry = await page.evaluate(async () => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
      window.dispatchEvent(new Event('resize'));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const overlay = document.querySelector('#stage');
      const webgl = document.querySelector('#stageGL');
      const rect = overlay.getBoundingClientRect();
      return {
        pixelRatio: window.devicePixelRatio,
        expectedWidth: Math.max(1, Math.round(rect.width * 2)),
        expectedHeight: Math.max(1, Math.round(rect.height * 2)),
        overlayWidth: overlay.width,
        overlayHeight: overlay.height,
        webglWidth: webgl.width,
        webglHeight: webgl.height
      };
    });
    if (retinaGeometry.overlayWidth !== retinaGeometry.expectedWidth || retinaGeometry.overlayHeight !== retinaGeometry.expectedHeight || retinaGeometry.webglWidth !== retinaGeometry.expectedWidth || retinaGeometry.webglHeight !== retinaGeometry.expectedHeight) {
      throw new Error(`HiDPI canvas buffers do not match the visible model view: ${JSON.stringify(retinaGeometry)}`);
    }

    await page.locator('#fullscreenBtn').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'viewPanel', null, { timeout });
    await page.waitForFunction(() => {
      const overlay = document.querySelector('#stage');
      const webgl = document.querySelector('#stageGL');
      return overlay.width === webgl.width && overlay.height === webgl.height;
    }, null, { timeout });
    const fullscreenGeometry = await page.evaluate(() => {
      const view = document.querySelector('#viewPanel');
      const rect = view.getBoundingClientRect();
      return {
        active: document.fullscreenElement === view,
        label: document.querySelector('#fullscreenBtn')?.getAttribute('aria-label'),
        width: rect.width,
        height: rect.height,
        expectedWidth: Math.round(rect.width * Math.min(window.devicePixelRatio || 1, 2)),
        expectedHeight: Math.round(rect.height * Math.min(window.devicePixelRatio || 1, 2)),
        overlay: [document.querySelector('#stage').width, document.querySelector('#stage').height],
        webgl: [document.querySelector('#stageGL').width, document.querySelector('#stageGL').height]
      };
    });
    if (!fullscreenGeometry.active || fullscreenGeometry.label !== 'Exit fullscreen' || Math.abs(fullscreenGeometry.width - 390) > 1 || Math.abs(fullscreenGeometry.height - 844) > 1 || fullscreenGeometry.overlay[0] !== fullscreenGeometry.expectedWidth || fullscreenGeometry.overlay[1] !== fullscreenGeometry.expectedHeight || JSON.stringify(fullscreenGeometry.overlay) !== JSON.stringify(fullscreenGeometry.webgl)) {
      throw new Error(`Fullscreen view did not fill and resize the model canvas: ${JSON.stringify(fullscreenGeometry)}`);
    }
    await page.locator('#fullscreenBtn').click();
    await page.waitForFunction(() => document.fullscreenElement === null, null, { timeout });
    await page.waitForFunction(() => document.querySelector('#fullscreenBtn')?.getAttribute('aria-label') === 'Enter fullscreen', null, { timeout });
    await page.setViewportSize({ width: 1440, height: 900 });

    const iterationBeforeRun = Number(await page.locator('#iterationValue').textContent());
    await page.locator('#status').click();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(previous => Number(document.querySelector('#iterationValue')?.textContent) > previous, iterationBeforeRun, { timeout });
    const keyboardRunIteration = Number(await page.locator('#iterationValue').textContent());
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(previous => Number(document.querySelector('#iterationValue')?.textContent) === previous - 1, keyboardRunIteration, { timeout });
    const rewoundIteration = Number(await page.locator('#iterationValue').textContent());
    await clickOgAction(page, 'input output', 'reset-model');
    await waitForStatus(page, () => document.querySelector('#status .message')?.textContent.startsWith('Model ready at iteration 0'), 'Reset after keyboard transport');

    const runtimeErrors = await page.evaluate(() => window.__embryomakerRuntimeErrors);
    for (const error of runtimeErrors) errors.push(`browser runtime error: ${error}`);
    if (errors.length) throw new Error(errors.join('\n'));
    await openOgMenu(page);
    await page.locator('[data-menu="quit"]').click();
    await page.waitForURL('about:blank', { timeout });
    for (const directory of ['output/Migration', 'images/Migration']) {
      if (!fs.existsSync(directory)) continue;
      for (const name of fs.readdirSync(directory)) {
        if (name.startsWith(smokeOutputPrefix)) fs.unlinkSync(`${directory}/${name}`);
      }
    }
    console.log(JSON.stringify({ ok: true, httpFraming, ogDisplayDefaults, ogRootMenus, ogRootActions, ogPropertyMenus, currentCellColoring, resetCamera, mobileGeometry, retinaGeometry, fullscreenGeometry, transport: { keyboardRunIteration, rewoundIteration, resetIteration: 0 }, ellipseGeometry, overlaySphereParity, litNodePixels, transparentGeometry, spatialOverlayGeometry, generatedEggshell: { sourceTriangles: generatedShellFrame.mesh.triangles.length, renderedTriangles: generatedShellFrame.frame.eggshellTriangles }, slicePlotParity, fixedBoundsBefore, fixedBoundsAfter, liveForceVectors, genePlotLegend, customInput, invalidInputStatus, editorBasicEpithelialCell, editorBasicMesenchymalCell, editorGeneEdit, editorNodePropertyPaste, editorCellPropertyPaste, editorNodePaste, editorCellPaste, editorNodeAddition, editorNodeDeletion, editorCellDeletion, editorEcmAddition, elongationFactor: expressionNode.elongationFactor, selectedNode, examples: loaded, apicalRecovery: degenerateStatus, controls: ['OG right-click menu', '1/100/1000/50000/custom iterations', 'reset'], quitUrl: page.url(), consoleErrors: 0, runtimeErrors: 0 }, null, 2));
  } finally {
    if (browser) await browser.close();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
