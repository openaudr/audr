import { describe, expect, it } from 'vitest';

import { createRecord, SPEC_VERSION, uuidv7, validate } from '../src/index.js';
import { EMITTER } from './helpers.js';

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const input = {
  emitter: EMITTER,
  resource: {
    provider: 'anthropic',
    type: 'model',
    name: 'claude-sonnet-5',
    operation: 'generation',
    modality: 'text',
  },
  usage: { llm: { input_tokens: 1200, output_tokens: 340 } },
  run: { run_id: '01J8ZQ8Y2K3M4N5P6Q7R8S9T0V', span_id: 'turn-3' },
  attribution: { environment: 'test' },
} as const;

describe('createRecord', () => {
  it('fills spec_version, record_id and event_time', () => {
    const before = Date.now();
    const record = createRecord(input);
    expect(record.spec_version).toBe(SPEC_VERSION);
    expect(record.record_id).toMatch(UUID7);
    expect(Date.parse(record.timing.event_time)).toBeGreaterThanOrEqual(before - 1);
    expect(record.timing.event_time).toMatch(/\.\d{3}Z$/);
    expect(validate(record)).toEqual([]);
  });

  it('keeps caller-supplied values', () => {
    const record = createRecord({
      ...input,
      spec_version: '1.0.1',
      record_id: '01J8ZQ8Y2K3M4N5P6Q7R8S9T0V',
      timing: { event_time: '2026-01-01T00:00:00.000Z', duration_ms: 812 },
    });
    expect(record.spec_version).toBe('1.0.1');
    expect(record.record_id).toBe('01J8ZQ8Y2K3M4N5P6Q7R8S9T0V');
    expect(record.timing).toEqual({ event_time: '2026-01-01T00:00:00.000Z', duration_ms: 812 });
  });

  it('renders a Date with millisecond precision', () => {
    const record = createRecord({
      ...input,
      timing: { event_time: new Date(Date.UTC(2026, 0, 2)) },
    });
    expect(record.timing.event_time).toBe('2026-01-02T00:00:00.000Z');
  });

  it('leaves an invalid Date for validation to report', () => {
    const record = createRecord({ ...input, timing: { event_time: new Date(Number.NaN) } });
    expect(validate(record)).toContainEqual(
      expect.objectContaining({ code: 'INVALID_DATETIME', path: '/timing/event_time' }),
    );
  });

  it('mints a fresh record_id every time', () => {
    expect(createRecord(input).record_id).not.toBe(createRecord(input).record_id);
  });
});

describe('uuidv7', () => {
  it('is a version 7, variant 1 UUID', () => {
    expect(uuidv7()).toMatch(UUID7);
  });

  it('encodes the timestamp in its first 48 bits', () => {
    const now = Date.UTC(2026, 8, 23, 10, 30);
    const hex = uuidv7(now).replaceAll('-', '').slice(0, 12);
    expect(Number.parseInt(hex, 16)).toBe(now);
  });

  it('sorts by creation time', () => {
    expect(uuidv7(1_000) < uuidv7(2_000)).toBe(true);
  });
});
