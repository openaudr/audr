/** The cross-language conformance gate: `conformance/cases.json` is the contract. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { encodeRecord, parseRecord, ValidationError } from '../src/index.js';

const ROOT = join(import.meta.dirname, '../../../..');

interface Case {
  readonly file: string;
  readonly expect: 'valid' | 'invalid';
  readonly note: string;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const CASES = (readJson('conformance/cases.json') as { cases: Case[] }).cases;
// The schema carries `x_*` annotations, which Ajv's strict mode would reject as unknown
// keywords. `event_time` is constrained by a pattern, so format assertion is not needed.
const schemaValidates = new Ajv2020({ strict: false, allErrors: true }).compile(
  readJson('spec/audr.schema.json') as object,
);

function load(testCase: Case): Record<string, unknown> {
  const payload = readJson(`conformance/fixtures/${testCase.file}`) as Record<string, unknown>;
  // `received_time` is stamped by the sink, so an emitter SDK never round-trips it.
  const timing = payload.timing as Record<string, unknown> | undefined;
  delete timing?.received_time;
  return payload;
}

function sdkAccepts(data: unknown): boolean {
  try {
    parseRecord(data);
    return true;
  } catch (error) {
    if (error instanceof ValidationError) return false;
    throw error;
  }
}

describe('conformance', () => {
  it('reads the whole manifest', () => {
    expect(CASES.length).toBe(38);
    expect(CASES.filter((testCase) => testCase.expect === 'valid').length).toBe(15);
  });

  it.each(CASES.map((testCase) => [testCase.file, testCase] as const))(
    '%s agrees with the manifest',
    (_file, testCase) => {
      expect(sdkAccepts(load(testCase)), testCase.note).toBe(testCase.expect === 'valid');
    },
  );

  it.each(
    CASES.filter((testCase) => testCase.expect === 'valid').map(
      (testCase) => [testCase.file, testCase] as const,
    ),
  )('%s round-trips and stays schema-valid', (_file, testCase) => {
    const encoded = JSON.parse(encodeRecord(parseRecord(load(testCase)))) as unknown;
    expect(schemaValidates(encoded), JSON.stringify(schemaValidates.errors)).toBe(true);
  });
});
