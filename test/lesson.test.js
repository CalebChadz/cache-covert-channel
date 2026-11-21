// The lesson's animated "stopwatch" sketch is an illustration, but its model
// should still behave: shares sum to 1 and the average climbs as the working
// set grows (that rising staircase is the whole point of Act 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lessonServed, lessonExpectedNs, LESSON_LEVELS } from '../src/lesson/sketches.js';

const KB = 1024, MB = 1024 * 1024;

test('served shares always sum to 1', () => {
  for (const w of [16 * KB, 200 * KB, 8 * MB, 20 * MB, 256 * MB]) {
    const s = lessonServed(w);
    assert.equal(s.length, LESSON_LEVELS.length);
    assert.ok(Math.abs(s.reduce((a, b) => a + b, 0) - 1) < 1e-9, `w=${w}`);
    assert.ok(s.every((f) => f >= 0));
  }
});

test('everything fits in L1 for a tiny working set', () => {
  assert.deepEqual(lessonServed(64 * KB), [1, 0, 0, 0]);
  assert.equal(lessonExpectedNs(64 * KB), LESSON_LEVELS[0].ns);
});

test('average read time never falls as the working set grows', () => {
  let prev = 0;
  for (let e = 14; e <= 28; e += 0.25) {
    const ns = lessonExpectedNs(2 ** e);
    assert.ok(ns >= prev - 1e-9, `dropped at 2^${e}`);
    prev = ns;
  }
  assert.ok(prev > 60, 'a huge working set is mostly DRAM');
});
