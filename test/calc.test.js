'use strict';
// Pinned to published NEC 2023 answers — if one of these fails, the tables
// are wrong, and wrong NEC math is worse than no calculator.
const { test } = require('node:test');
const assert = require('node:assert');
const calc = require('../lib/calc');

test('conduit fill: 9 × #12 THHN max in 1/2" EMT (classic answer)', () => {
  assert.equal(calc.conduitMaxCount({ conduitType: 'EMT', size: '1/2', insul: 'THHN', wireSize: '12' }), 9);
});

test('conduit fill: 16 × #12 THHN max in 3/4" EMT', () => {
  assert.equal(calc.conduitMaxCount({ conduitType: 'EMT', size: '3/4', insul: 'THHN', wireSize: '12' }), 16);
});

test('conduit fill: 3 × #12 THHN in 1/2" EMT is fine at 40%', () => {
  const r = calc.conduitFill({ conduitType: 'EMT', size: '1/2', conductors: [{ insul: 'THHN', size: '12', count: 3 }] });
  assert.ok(r.ok);
  assert.ok(Math.abs(r.areaUsed - 0.0399) < 0.0001);
  assert.equal(r.limitPct, 0.40);
});

test('conduit fill: 2 conductors use the 31% limit', () => {
  const r = calc.conduitFill({ conduitType: 'EMT', size: '1/2', conductors: [{ insul: 'THHN', size: '1', count: 2 }] });
  assert.equal(r.limitPct, 0.31);
  assert.ok(!r.ok); // 2 × 0.1562 = 0.3124 > 0.304 × 0.31
});

test('box fill: 314.16 worked example', () => {
  // 3 × #12 + 2 × #14, one device on #12, grounds present, clamps
  const r = calc.boxFill({
    conductors: { '12': 3, '14': 2 },
    devices: [{ size: '12' }],
    clamps: true,
    groundsPresent: true,
  });
  // 3×2.25 + 2×2.0 + 2×2.25 (device) + 2.25 (clamps) + 2.25 (grounds) = 19.75
  assert.equal(r.volume, 19.75);
  assert.equal(r.largest, '12');
});

test('ampacity: #12 Cu 75°C base is 25A, breaker capped at 20A', () => {
  const r = calc.ampacity({ size: '12', material: 'CU', tempRating: 75 });
  assert.equal(r.base, 25);
  assert.equal(r.breakerCap, 20);
  assert.equal(r.adjusted, 25);
});

test('ampacity: derating at 45°C ambient and 9 CCC (90°C column)', () => {
  const r = calc.ampacity({ size: '10', material: 'CU', tempRating: 90, ambientC: 45, ccc: 9 });
  assert.equal(r.base, 40);
  assert.equal(r.ambientFactor, 0.87);
  assert.equal(r.cccFactor, 0.7);
  assert.ok(Math.abs(r.adjusted - 24.36) < 0.01);
});

test('voltage drop: 100ft #10 Cu at 20A / 120V single phase ≈ 4.97V (4.1%)', () => {
  const r = calc.voltageDrop({ volts: 120, amps: 20, feet: 100, size: '10', material: 'CU', phase: 1 });
  assert.ok(Math.abs(r.drop - 4.971) < 0.01);
  assert.ok(!r.ok); // over the 3% guideline
});

test('voltage drop: three phase uses √3 instead of 2', () => {
  const r1 = calc.voltageDrop({ volts: 208, amps: 20, feet: 100, size: '10', phase: 1 });
  const r3 = calc.voltageDrop({ volts: 208, amps: 20, feet: 100, size: '10', phase: 3 });
  assert.ok(Math.abs(r3.drop / r1.drop - Math.sqrt(3) / 2) < 0.001);
});

test('wire weight round-trips', () => {
  const w = calc.wireWeight({ size: '12', feet: 1000 });
  assert.equal(w.pounds, 24);
  const f = calc.wireFeetFromWeight({ size: '12', pounds: 24 });
  assert.ok(Math.abs(f.feet - 1000) < 0.01);
});

test('unknown sizes throw instead of guessing', () => {
  assert.throws(() => calc.ampacity({ size: '13' }));
  assert.throws(() => calc.conduitFill({ conduitType: 'EMT', size: '5', conductors: [] }));
});
