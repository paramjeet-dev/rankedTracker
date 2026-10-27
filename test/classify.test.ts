import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../src/shared/classify.js';

const http = (status: number, reason: string, message = 'x') => Object.assign(new Error(message), { status, reason });

test('HTML body hidden behind a JSON parse error closes the gate', () => {
  const err = new SyntaxError(`Unexpected token '<', "<html>\n<h"... is not valid JSON`);
  const c = classifyError(err);
  assert.equal(c.kind, 'unavailable');
  assert.equal(c.closesGate, true);
  assert.equal(c.permanent, false);
  assert.equal(c.pressure, true);
});

test('truncated JSON is a transient server problem, not an outage', () => {
  const c = classifyError(new SyntaxError('Unexpected end of JSON input'));
  assert.equal(c.kind, 'server');
  assert.equal(c.closesGate, false);
});

test('invalid IP -> auth, closes gate', () => {
  const c = classifyError(http(403, 'accessDenied.invalidIp', 'Invalid authorization: API key does not allow access from IP 1.2.3.4'));
  assert.equal(c.kind, 'auth');
  assert.equal(c.closesGate, true);
});

test('private war log 403 is permanent, not auth', () => {
  const c = classifyError(http(403, 'privateWarLog'));
  assert.equal(c.kind, 'forbidden');
  assert.equal(c.permanent, true);
  assert.equal(c.closesGate, false);
});

test('maintenance (503 inMaintenance)', () => {
  const c = classifyError(http(503, 'inMaintenance'));
  assert.equal(c.kind, 'maintenance');
  assert.equal(c.closesGate, true);
});

test('500 unknownException is transient and does not close the gate', () => {
  const c = classifyError(http(500, 'unknownException', 'Unknown error happened when handling the request.'));
  assert.equal(c.kind, 'server');
  assert.equal(c.closesGate, false);
  assert.equal(c.permanent, false);
});

test('500 with a maintenance message is maintenance', () => {
  assert.equal(classifyError(http(500, 'unknownException', 'Service is down for maintenance')).kind, 'maintenance');
});

test('429 throttled applies pressure', () => {
  const c = classifyError(http(429, 'requestThrottled'));
  assert.equal(c.kind, 'throttled');
  assert.equal(c.pressure, true);
});

test('404 and 400 are permanent', () => {
  assert.equal(classifyError(http(404, 'notFound')).permanent, true);
  assert.equal(classifyError(http(400, 'badRequest')).permanent, true);
});

test('502/504 are gateway outages', () => {
  assert.equal(classifyError(http(502, '')).kind, 'unavailable');
  assert.equal(classifyError(http(504, '')).kind, 'unavailable');
});

test('network errors close the gate; aborts are timeouts', () => {
  assert.equal(classifyError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).kind, 'unavailable');
  assert.equal(classifyError(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })).kind, 'unavailable');
  assert.equal(classifyError(Object.assign(new Error('aborted'), { code: 'UND_ERR_ABORTED' })).kind, 'timeout');
});

test('garbage input does not throw', () => {
  assert.equal(classifyError(undefined).kind, 'unknown');
  assert.equal(classifyError('boom').kind, 'unknown');
});
