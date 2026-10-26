const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
  const html = fs.readFileSync('docs/downloads/index.html', 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'downloads page release lookup script is missing');

  const elements = Object.fromEntries(
    ['releaseVersion', 'macDownload', 'linuxDownload', 'checksumDownload'].map(id => [id, { textContent: '', href: '' }]),
  );
  const assets = [
    { name: 'EmbryoMaker-Flow-macos-arm64-v0.2.0.zip', browser_download_url: 'https://example.test/mac.zip' },
    { name: 'EmbryoMaker-Flow-linux-x86_64-v0.2.0.tar.gz', browser_download_url: 'https://example.test/linux.tar.gz' },
    { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.test/SHA256SUMS.txt' },
  ];
  const context = {
    fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'v0.2.0', assets }) }),
    document: { getElementById: id => elements[id] },
    Map,
    Error,
  };
  vm.runInNewContext(match[1], context);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(elements.releaseVersion.textContent, 'Version 0.2.0');
  assert.equal(elements.macDownload.href, assets[0].browser_download_url);
  assert.equal(elements.linuxDownload.href, assets[1].browser_download_url);
  assert.equal(elements.checksumDownload.href, assets[2].browser_download_url);
  process.stdout.write('Downloads page maps the latest release assets.\n');
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
