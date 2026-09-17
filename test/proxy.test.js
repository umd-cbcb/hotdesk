'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { clientIp } = require('../server/index');

/**
 * X-Forwarded-For is partly attacker-controlled: a request arriving with
 * `X-Forwarded-For: 1.2.3.4` leaves the balancer as `1.2.3.4, <real client>`.
 * Which end you read from is therefore a security decision, not a detail.
 */

const req = (xff, socketIp = '10.0.0.1') => ({
  headers: xff === null ? {} : { 'x-forwarded-for': xff },
  socket: { remoteAddress: socketIp },
});

test('with no trusted proxy, only the socket is believed', () => {
  assert.equal(clientIp(req('1.2.3.4'), 0), '10.0.0.1',
    'a header alone must never choose the rate-limit bucket');
  assert.equal(clientIp(req(null), 0), '10.0.0.1');
});

test('behind one proxy, the entry our own proxy appended wins', () => {
  // The client seeded "1.2.3.4"; the balancer appended the real address.
  assert.equal(clientIp(req('1.2.3.4, 203.0.113.9'), 1), '203.0.113.9');
  // Taking the leftmost would hand every attacker their own fresh bucket.
  assert.notEqual(clientIp(req('1.2.3.4, 203.0.113.9'), 1), '1.2.3.4');
});

test('a longer spoofed chain still cannot reach past our proxy', () => {
  assert.equal(clientIp(req('evil, evil2, evil3, 203.0.113.9'), 1), '203.0.113.9');
});

test('two proxies count back two hops', () => {
  assert.equal(clientIp(req('1.2.3.4, 203.0.113.9, 10.0.0.5'), 2), '203.0.113.9');
});

test('a header shorter than the hop count falls back to the socket', () => {
  // Rather than silently picking whatever is there, which would be spoofable.
  assert.equal(clientIp(req('203.0.113.9'), 2), '10.0.0.1');
  assert.equal(clientIp(req(null), 1), '10.0.0.1');
});

test('TRUST_PROXY parses as a hop count, with the boolean spellings still working', () => {
  const read = (v) => execFileSync(process.execPath, ['-e',
    'process.stdout.write(String(require(' +
    JSON.stringify(path.join(__dirname, '..', 'server', 'config.js')) + ').trustProxy))'
  ], { encoding: 'utf8',
       env: Object.assign({}, process.env, { TRUST_PROXY: v, HOTDESK_ENV: '/nonexistent' }) });

  assert.equal(read('0'), '0');
  assert.equal(read(''), '0');
  assert.equal(read('false'), '0');
  assert.equal(read('true'), '1', 'the old boolean form means one proxy');
  assert.equal(read('1'), '1');
  assert.equal(read('2'), '2');
  assert.equal(read('garbage'), '0', 'nonsense is not trusted');
});
