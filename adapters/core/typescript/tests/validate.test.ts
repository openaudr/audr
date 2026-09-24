import { describe, expect, it } from 'vitest';

import { type AudrRecord, validate } from '../src/index.js';
import { makeRecord } from '../src/testing.js';

type Pair = [code: string, path: string];

function pairs(value: unknown, now?: Date): Pair[] {
  return validate(value, now ? { now } : {}).map((found) => [found.code, found.path]);
}

/** A structurally loose copy of a valid record with `changes` merged into one block. */
function withBlock(block: keyof AudrRecord, changes: Record<string, unknown>): unknown {
  const record = makeRecord() as unknown as Record<string, Record<string, unknown>>;
  return { ...record, [block]: { ...record[block], ...changes } };
}

const toolResource = {
  provider: 'self-hosted',
  type: 'tool',
  name: 'search',
  operation: 'tool_execution',
} as const;

describe('validate: structure', () => {
  it('accepts a valid record', () => {
    expect(pairs(makeRecord())).toEqual([]);
  });

  it('rejects a value that is not an object', () => {
    expect(pairs('record')).toEqual([['INVALID_TYPE', '/']]);
    expect(pairs(null)).toEqual([['INVALID_TYPE', '/']]);
    expect(pairs([])).toEqual([['INVALID_TYPE', '/']]);
  });

  it('reports every missing required property', () => {
    expect(pairs({})).toEqual([
      ['REQUIRED', '/spec_version'],
      ['REQUIRED', '/record_id'],
      ['REQUIRED', '/emitter'],
      ['REQUIRED', '/timing'],
      ['REQUIRED', '/resource'],
      ['REQUIRED', '/usage'],
      ['REQUIRED', '/run'],
      ['REQUIRED', '/attribution'],
    ]);
  });

  it('rejects unknown properties, escaping the name in the pointer', () => {
    expect(pairs({ ...makeRecord(), 'a/b~c': 1 })).toEqual([['UNKNOWN_PROPERTY', '/a~1b~0c']]);
    expect(pairs(withBlock('emitter', { extra: 'x' }))).toEqual([
      ['UNKNOWN_PROPERTY', '/emitter/extra'],
    ]);
  });

  it('rejects __proto__ as an unknown property, not as a prototype', () => {
    const json = JSON.stringify(makeRecord());
    const parsed = (text: string): unknown => JSON.parse(text);
    expect(pairs(parsed(`${json.slice(0, -1)},"__proto__":{"a":1}}`))).toEqual([
      ['UNKNOWN_PROPERTY', '/__proto__'],
    ]);
    expect(pairs(parsed(json.replace('"llm":{', '"llm":{"__proto__":1,')))).toEqual([
      ['UNKNOWN_PROPERTY', '/usage/llm/__proto__'],
    ]);
    const labels = json.replace('"attribution":{', '"attribution":{"labels":{"__proto__":1},');
    expect(pairs(parsed(labels))).toEqual([['INVALID_TYPE', '/attribution/labels/*']]);
  });

  it('rejects wrong types, bad enumerants and empty strings', () => {
    expect(pairs(withBlock('emitter', { component: 'sdk' }))).toEqual([
      ['INVALID_ENUM', '/emitter/component'],
    ]);
    expect(pairs(withBlock('emitter', { name: '' }))).toEqual([
      ['INVALID_STRING', '/emitter/name'],
    ]);
    expect(pairs(withBlock('emitter', { version: 1 }))).toEqual([
      ['INVALID_TYPE', '/emitter/version'],
    ]);
    expect(pairs({ ...makeRecord(), resource: 'model' })).toEqual([['INVALID_TYPE', '/resource']]);
  });

  it('measures string length in code points, as JSON Schema does', () => {
    expect(pairs(withBlock('run', { error_reason: '😀'.repeat(32) }))).toEqual([]);
    expect(pairs(withBlock('run', { error_reason: '😀'.repeat(33) }))).toEqual([
      ['STRING_TOO_LONG', '/run/error_reason'],
    ]);
    expect(pairs(withBlock('run', { run_id: '😀'.repeat(7) }))).toEqual([
      ['INVALID_STRING', '/run/run_id'],
    ]);
    // A lone surrogate is one code point.
    expect(pairs(withBlock('run', { error_reason: '\uD800'.repeat(32) }))).toEqual([]);
  });

  it('treats null as a wrong type rather than absent', () => {
    expect(pairs(withBlock('run', { name: null }))).toEqual([['INVALID_TYPE', '/run/name']]);
  });

  it('gates spec_version on the 1.0.x family', () => {
    expect(pairs({ ...makeRecord(), spec_version: '2.0.0' })).toEqual([
      ['UNSUPPORTED_VERSION', '/spec_version'],
    ]);
  });

  it('requires record_id and corrects to be a ULID or a UUIDv7', () => {
    expect(pairs({ ...makeRecord(), record_id: 'not-an-id-1' })).toEqual([
      ['INVALID_IDENTIFIER', '/record_id'],
    ]);
    expect(pairs({ ...makeRecord(), corrects: 'not-an-id-1' })).toEqual([
      ['INVALID_IDENTIFIER', '/corrects'],
    ]);
    expect(pairs({ ...makeRecord(), record_id: '01927f1c-2b3d-7abc-8def-0123456789ab' })).toEqual(
      [],
    );
    expect(pairs({ ...makeRecord(), corrects: '01J8ZQ8Y2K3M4N5P6Q7R8S9T0V' })).toEqual([]);
  });

  it('checks resource and run string constraints', () => {
    expect(pairs(withBlock('resource', { provider: 'Anthropic' }))).toEqual([
      ['INVALID_STRING', '/resource/provider'],
    ]);
    expect(pairs(withBlock('run', { run_id: 'short' }))).toEqual([
      ['INVALID_STRING', '/run/run_id'],
    ]);
    expect(pairs(withBlock('run', { run_id: 'x'.repeat(65) }))).toEqual([
      ['STRING_TOO_LONG', '/run/run_id'],
    ]);
    expect(pairs(withBlock('run', { error_reason: 'x'.repeat(33) }))).toEqual([
      ['STRING_TOO_LONG', '/run/error_reason'],
    ]);
    expect(pairs(withBlock('run', { trace_id: 'xyz' }))).toEqual([
      ['INVALID_IDENTIFIER', '/run/trace_id'],
    ]);
    expect(pairs(withBlock('run', { trace_id: '0af7651916cd43dd8448eb211c80319c' }))).toEqual([]);
  });

  it('requires counters to be non-negative finite numbers, integers where the schema says so', () => {
    const llm = (counters: Record<string, unknown>): unknown =>
      withBlock('usage', { llm: counters });
    expect(pairs(llm({ input_tokens: -1 }))).toEqual([
      ['INVALID_COUNTER', '/usage/llm/input_tokens'],
    ]);
    expect(pairs(llm({ input_tokens: 1.5 }))).toEqual([
      ['INVALID_TYPE', '/usage/llm/input_tokens'],
    ]);
    expect(pairs(llm({ input_tokens: '5' }))).toEqual([
      ['INVALID_TYPE', '/usage/llm/input_tokens'],
    ]);
    expect(pairs(llm({ audio_input_seconds: 1.5 }))).toEqual([]);
    expect(pairs(llm({ audio_input_seconds: Infinity }))).toEqual([
      ['INVALID_COUNTER', '/usage/llm/audio_input_seconds'],
    ]);
    expect(pairs(withBlock('timing', { duration_ms: -5 }))).toEqual([
      ['INVALID_COUNTER', '/timing/duration_ms'],
    ]);
  });

  it('admits x_* extension counters and rejects other names', () => {
    const llm = (counters: Record<string, unknown>): unknown =>
      withBlock('usage', { llm: counters });
    expect(pairs(llm({ x_acme_widgets: 2.5 }))).toEqual([]);
    expect(pairs(llm({ x_acme_widgets: -1 }))).toEqual([
      ['INVALID_COUNTER', '/usage/llm/x_acme_widgets'],
    ]);
    expect(pairs(llm({ x_Bad: 1 }))).toEqual([['UNKNOWN_PROPERTY', '/usage/llm/x_Bad']]);
  });

  it('rejects empty usage blocks', () => {
    expect(pairs(withBlock('usage', { llm: {} }))).toEqual([['EMPTY_USAGE', '/usage/llm']]);
    const record = { ...makeRecord(), resource: toolResource, usage: { tool: {} } };
    expect(pairs(record)).toEqual([['EMPTY_USAGE', '/usage/tool']]);
  });

  it('checks cost amounts, currency and blocks', () => {
    const cost = (value: Record<string, unknown>): unknown => ({ ...makeRecord(), cost: value });
    expect(pairs(cost({ total_cost: 1, currency: 'USD' }))).toEqual([]);
    expect(pairs(cost({ total_cost: -1, currency: 'USD' }))).toEqual([
      ['INVALID_COST', '/cost/total_cost'],
    ]);
    expect(pairs(cost({ total_cost: 1, currency: 'usd' }))).toEqual([
      ['INVALID_CURRENCY', '/cost/currency'],
    ]);
    expect(pairs(cost({ total_cost: 1, currency: 'USD', discount_percent: 101 }))).toEqual([
      ['INVALID_COST', '/cost/discount_percent'],
    ]);
    expect(pairs(cost({ total_cost: 1 }))).toEqual([['REQUIRED', '/cost/currency']]);
    expect(pairs(cost({ total_cost: 1, currency: 'USD', llm: {} }))).toEqual([
      ['REQUIRED', '/cost/llm/total_token_cost'],
    ]);
    expect(
      pairs(cost({ total_cost: 1, currency: 'USD', llm: { x_a: 1, total_token_cost: 1 } })),
    ).toEqual([['UNKNOWN_PROPERTY', '/cost/llm/x_a']]);
  });

  it('validates labels without copying caller keys into paths', () => {
    const labels = (value: unknown): unknown =>
      withBlock('attribution', { environment: 'test', labels: value });
    expect(pairs(labels({ team: 'research' }))).toEqual([]);
    expect(pairs(labels({ 'alice@example.com': 'x' }))).toEqual([
      ['INVALID_PROPERTY_NAME', '/attribution/labels/*'],
    ]);
    expect(pairs(labels({ team: 'x'.repeat(257) }))).toEqual([
      ['STRING_TOO_LONG', '/attribution/labels/*'],
    ]);
    expect(pairs(labels({ team: 1 }))).toEqual([['INVALID_TYPE', '/attribution/labels/*']]);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${String(i)}`, 'v']));
    expect(pairs(labels(many))).toEqual([['TOO_MANY_PROPERTIES', '/attribution/labels']]);
    expect(pairs(labels('team'))).toEqual([['INVALID_TYPE', '/attribution/labels']]);
  });

  it('forbids received_time, which only a sink sets', () => {
    expect(pairs(withBlock('timing', { received_time: '2026-01-01T00:00:00.000Z' }))).toEqual([
      ['FORBIDDEN', '/timing/received_time'],
    ]);
  });

  it.each([
    '2026-01-01',
    '2026-01-01 00:00:00Z',
    '2026-01-01T00:00:00',
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:00:00+25:00',
  ])('rejects the malformed timestamp %s', (eventTime) => {
    expect(pairs(withBlock('timing', { event_time: eventTime }))).toEqual([
      ['INVALID_DATETIME', '/timing/event_time'],
    ]);
  });

  it('rejects a non-string timestamp', () => {
    expect(pairs(withBlock('timing', { event_time: Date.now() }))).toEqual([
      ['INVALID_TYPE', '/timing/event_time'],
    ]);
  });
});

describe('validate: cross-field rules', () => {
  const at = (eventTime: string): unknown => withBlock('timing', { event_time: eventTime });

  it('requires millisecond precision but tolerates trailing zeros', () => {
    expect(pairs(at('2026-01-01T00:00:00.123456Z'))).toEqual([
      ['MILLISECOND_PRECISION', '/timing/event_time'],
    ]);
    expect(pairs(at('2026-01-01T00:00:00.123000Z'))).toEqual([]);
    expect(pairs(at('2026-01-01T00:00:00Z'))).toEqual([]);
  });

  it('rejects event times more than five minutes ahead of now', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(pairs(at('2026-01-01T00:04:59.000Z'), now)).toEqual([]);
    expect(pairs(at('2026-01-01T00:05:01.000Z'), now)).toEqual([
      ['FUTURE_EVENT_TIME', '/timing/event_time'],
    ]);
    expect(pairs(at('2026-01-01T02:00:00.000+02:00'), now)).toEqual([]);
    expect(pairs(at('2025-12-31T20:00:00.000-05:00'), now)).toEqual([
      ['FUTURE_EVENT_TIME', '/timing/event_time'],
    ]);
  });

  it('requires exactly one usage block', () => {
    expect(pairs(withBlock('usage', { tool: { call_count: 1 } }))).toEqual([
      ['INVALID_STRUCTURE', '/usage'],
    ]);
    expect(pairs({ ...makeRecord(), usage: {} })).toEqual([['INVALID_STRUCTURE', '/usage']]);
  });

  it('holds model operations to type, modality, usage and cost', () => {
    expect(pairs(withBlock('resource', { type: 'tool' }))).toEqual([
      ['INVALID_STRUCTURE', '/resource/type'],
    ]);
    expect(pairs(withBlock('resource', { modality: undefined }))).toEqual([
      ['REQUIRED', '/resource/modality'],
    ]);
    const cost = { total_cost: 1, currency: 'USD', tool: { call_cost: 1 } };
    expect(pairs({ ...makeRecord(), cost })).toEqual([['FORBIDDEN', '/cost/tool']]);
  });

  it('holds tool operations to type, usage and cost', () => {
    const tool = { ...makeRecord(), resource: toolResource, usage: { tool: { call_count: 1 } } };
    expect(pairs(tool)).toEqual([]);
    expect(pairs({ ...tool, usage: { llm: { input_tokens: 1 } } })).toEqual([
      ['INVALID_STRUCTURE', '/usage'],
    ]);
    expect(pairs({ ...tool, resource: { ...toolResource, type: 'model' } })).toEqual([
      ['INVALID_STRUCTURE', '/resource/type'],
    ]);
    const cost = { total_cost: 1, currency: 'USD', llm: { total_token_cost: 1 } };
    expect(pairs({ ...tool, cost })).toEqual([['FORBIDDEN', '/cost/llm']]);
  });

  it('applies the attribution rules', () => {
    const attribution = (value: Record<string, unknown>): unknown => ({
      ...makeRecord(),
      attribution: value,
    });
    expect(pairs(attribution({}))).toEqual([['REQUIRED', '/attribution/environment']]);
    expect(pairs(attribution({ environment: 'production' }))).toEqual([
      ['REQUIRED', '/attribution/account_id'],
    ]);
    expect(pairs(attribution({ environment: 'production', account_id: 'acct' }))).toEqual([]);
    expect(pairs(attribution({ environment: 'test', user_id: 'a@b.c' }))).toEqual([
      ['NON_PSEUDONYMOUS_ID', '/attribution/user_id'],
    ]);
  });

  it('reports every cross-field issue at once, each only once', () => {
    const record = {
      ...makeRecord(),
      resource: { ...toolResource, operation: 'generation' },
      usage: {},
      attribution: { environment: 'production', user_id: 'a@b.c' },
    };
    expect(pairs(record)).toEqual([
      ['INVALID_STRUCTURE', '/usage'],
      ['INVALID_STRUCTURE', '/resource/type'],
      ['REQUIRED', '/resource/modality'],
      ['REQUIRED', '/attribution/account_id'],
      ['NON_PSEUDONYMOUS_ID', '/attribution/user_id'],
    ]);
  });

  it('never puts a record value in a message', () => {
    const secret = 'alice@example.com';
    const issues = validate(
      withBlock('attribution', { user_id: secret, labels: { [secret]: secret } }),
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(issues)).not.toContain(secret);
  });
});
