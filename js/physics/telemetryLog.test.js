import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS, createLog, logStep, logLength, logWrapped, logAt, channel,
  resetLog, toCSV, diffLogs, DEFAULT_DECIMATION,
} from './telemetryLog.js';

const sample = over => ({ t: 0, speed: 0, ...over });

test('every channel is a distinct name, so the CSV header is unambiguous', () => {
  assert.equal(new Set(CHANNELS).size, CHANNELS.length);
});

test('decimation keeps one sample in DEFAULT_DECIMATION', () => {
  const log = createLog(100);
  for (let i = 0; i < 60; i++) logStep(log, sample({ t: i }));
  assert.equal(logLength(log), 60 / DEFAULT_DECIMATION);
});

test('undecimated logging keeps every step', () => {
  const log = createLog(100, 1);
  for (let i = 0; i < 30; i++) logStep(log, sample({ t: i }));
  assert.equal(logLength(log), 30);
  assert.equal(logAt(log, 7).t, 7);
});

test('a missing channel reads as zero rather than as the previous sample', () => {
  const log = createLog(4, 1);
  logStep(log, { t: 1, speed: 50 });
  logStep(log, { t: 2 });
  assert.equal(logAt(log, 1).speed, 0, 'a gap must read as a gap');
});

test('a wrapped log keeps the most recent window', () => {
  const log = createLog(4, 1);
  for (let i = 0; i < 10; i++) logStep(log, sample({ t: i }));
  assert.ok(logWrapped(log));
  assert.equal(logLength(log), 4);
  assert.deepEqual([...channel(log, 't')], [6, 7, 8, 9]);
});

test('booleans are stored as 1 and 0', () => {
  const log = createLog(4, 1);
  logStep(log, { brake: true, drs: false });
  assert.equal(logAt(log, 0).brake, 1);
  assert.equal(logAt(log, 0).drs, 0);
});

test('resetLog empties it and restarts decimation', () => {
  const log = createLog(8, 2);
  logStep(log, sample({ t: 5 }));
  resetLog(log);
  assert.equal(logLength(log), 0);
  assert.equal(log.stepCount, 0);
});

test('CSV starts with the channel header and has one row per sample', () => {
  const log = createLog(8, 1);
  for (let i = 0; i < 3; i++) logStep(log, sample({ t: i, speed: i * 10 }));
  const lines = toCSV(log).trim().split('\n');
  assert.equal(lines[0], CHANNELS.join(','));
  assert.equal(lines.length, 4);
  assert.equal(lines[2].split(',').length, CHANNELS.length);
});

test('CSV of the same log twice is byte-identical, so diff is usable', () => {
  const log = createLog(8, 1);
  for (let i = 0; i < 5; i++) logStep(log, sample({ t: i / 3, speed: Math.PI * i }));
  assert.equal(toCSV(log), toCSV(log));
});

test('CSV trims trailing zeros without losing the value', () => {
  const log = createLog(4, 1);
  logStep(log, { t: 1.5, speed: 0 });
  const row = toCSV(log).trim().split('\n')[1].split(',');
  assert.equal(row[CHANNELS.indexOf('t')], '1.5');
  assert.equal(row[CHANNELS.indexOf('speed')], '0');
});

test('diffing a log against itself reports zero everywhere', () => {
  const log = createLog(16, 1);
  for (let i = 0; i < 10; i++) logStep(log, sample({ t: i, speed: i * i }));
  const { rows, samples } = diffLogs(log, log);
  assert.equal(samples, 10);
  assert.ok(rows.every(r => r.maxAbs === 0 && r.rms === 0));
});

test('diffing ranks the channel that moved most first, and says where', () => {
  const a = createLog(16, 1);
  const b = createLog(16, 1);
  for (let i = 0; i < 10; i++) {
    logStep(a, sample({ t: i, speed: 10 }));
    logStep(b, sample({ t: i, speed: i === 7 ? 40 : 10 }));
  }
  const { rows } = diffLogs(a, b);
  assert.equal(rows[0].channel, 'speed');
  assert.equal(rows[0].maxAbs, 30);
  assert.equal(rows[0].atSample, 7, 'must point at the sample that diverged');
  assert.equal(rows[1].maxAbs, 0, 'nothing else moved');
});

test('diffing logs of different lengths compares the overlap', () => {
  const a = createLog(16, 1);
  const b = createLog(16, 1);
  for (let i = 0; i < 10; i++) logStep(a, sample({ t: i }));
  for (let i = 0; i < 4; i++) logStep(b, sample({ t: i }));
  assert.equal(diffLogs(a, b).samples, 4);
});
