/**
 * The Host check behind src/proxy.ts.
 *
 * A DNS-rebinding page is same-origin as far as the browser is concerned, so
 * Sec-Fetch-Site cannot see it; the Host header still carries the attacker's
 * domain. These tests pin down which names count as the app's own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHost } from '../src/lib/local-host.ts';

test('loopback names are accepted on any port', () => {
  for (const host of ['127.0.0.1:49731', 'localhost:3000', 'LOCALHOST:3000', '127.0.0.1', 'localhost', '[::1]:3000']) {
    assert.ok(isLoopbackHost(host), host);
  }
});

test('any other name is refused, however much it resembles loopback', () => {
  for (const host of [
    'evil.example:49731', 'evil.example', '127.0.0.1.evil.example:3000', 'localhost.evil.example',
    '127.0.0.1:3000@evil.example', 'evil.example/127.0.0.1', '192.168.1.10:3000', '0.0.0.0:3000',
    '127.0.0.2:3000', 'localhost:', 'localhost:abc', '', ' ',
  ]) {
    assert.ok(!isLoopbackHost(host), host);
  }
  assert.ok(!isLoopbackHost(null));
  assert.ok(!isLoopbackHost(undefined));
});
