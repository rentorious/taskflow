import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEstimate, sumEstimates } from '../scripts/report/estimates.mjs';

const range = (raw) => {
  const e = parseEstimate(raw);
  return [e.minMinutes, e.maxMinutes, e.parsed, e.caveat];
};

test('plain quantities', () => {
  assert.deepEqual(range('30 min'), [30, 30, true, false]);
  assert.deepEqual(range('2 hours'), [120, 120, true, false]);
  assert.deepEqual(range('1.5 hours'), [90, 90, true, false]);
  assert.deepEqual(range('~2h'), [120, 120, true, false]);
  assert.deepEqual(range('1h 30m'), [90, 90, true, false]);
  assert.deepEqual(range('2 days'), [960, 960, true, false]);
});

test('ranges, including a left side that borrows its unit', () => {
  assert.deepEqual(range('30-45 min'), [30, 45, true, false]);
  assert.deepEqual(range('10–15 min'), [10, 15, true, false]);
  assert.deepEqual(range('2-4 hours'), [120, 240, true, false]);
  assert.deepEqual(range('30 min - 1 hour'), [30, 60, true, false]);
  assert.deepEqual(range('1 to 2 hours'), [60, 120, true, false]);
});

test('multi-clause prose keeps the leading range and raises a caveat', () => {
  assert.deepEqual(range('24-32 hours total across phases (Phase 1 about 12h; Phase 2 about 16h)'), [1440, 1920, true, true]);
  assert.deepEqual(range('6-9 hours (Phase 1 3-4h), blocked on a payment account'), [360, 540, true, true]);
});

test('unparseable input is reported, never guessed', () => {
  assert.deepEqual(range('unknown'), [null, null, false, true]);
  assert.deepEqual(range(''), [null, null, false, false]);
  assert.deepEqual(range(undefined), [null, null, false, false]);
  assert.deepEqual(range('5 months'), [null, null, false, false]);
});

test('sums give a range plus honesty counters', () => {
  const total = sumEstimates(['30-45 min', '2 hours', 'unknown', '', '6-9 hours (Phase 1), blocked'].map(parseEstimate));
  assert.deepEqual(total, { minMinutes: 510, maxMinutes: 705, count: 4, unparsed: 1, caveats: 2 });
});
