const test = require('node:test'), assert = require('node:assert/strict');
const { cmpVersion, pickAsset } = require('../lib/updater');
test('버전 비교는 숫자 단위 (1.0.10 > 1.0.9, v 접두어 무시)', () => {
  assert.ok(cmpVersion('1.0.10', '1.0.9') > 0);
  assert.ok(cmpVersion('v1.0.2', '1.0.1') > 0);
  assert.equal(cmpVersion('1.0.1', 'v1.0.1'), 0);
  assert.ok(cmpVersion('1.0.1', '1.1.0') < 0);
});
test('이 아키텍처용 zip만 고른다', () => {
  const rel = { assets: [{ name: 'Hoo-1.0.2-x64.zip' }, { name: 'Hoo-1.0.2-arm64.zip' }, { name: 'notes.txt' }] };
  assert.equal(pickAsset(rel, 'arm64').name, 'Hoo-1.0.2-arm64.zip');
  assert.equal(pickAsset(rel, 'x64').name, 'Hoo-1.0.2-x64.zip');
  assert.equal(pickAsset({ assets: [] }, 'arm64'), null);
});
