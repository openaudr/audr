/**
 * The validator is written by hand from `spec/audr.schema.json`. These tests fail when the
 * two drift: a property, a required list, an enumerant, or a length or numeric bound that
 * one has and the other lacks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  EMITTER_COMPONENTS,
  ENVIRONMENTS,
  MODALITIES,
  OPERATIONS,
  RESOURCE_TYPES,
  RUN_OUTCOMES,
  RUN_TYPES,
  SHAPES,
  SPEC_VERSION,
} from '../src/schema.js';
import { makeRecord } from '../src/testing.js';
import { validate } from '../src/validate.js';

interface SchemaNode {
  readonly $id?: string;
  readonly properties?: Record<string, SchemaNode>;
  readonly required?: string[];
  readonly patternProperties?: Record<string, SchemaNode>;
  readonly additionalProperties?: SchemaNode | boolean;
  readonly propertyNames?: SchemaNode;
  readonly enum?: string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

const SCHEMA = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../../spec/audr.schema.json'), 'utf8'),
) as SchemaNode;

function node(dotted: string): SchemaNode {
  return dotted
    .split('.')
    .filter(Boolean)
    .reduce<SchemaNode>((current, key) => current.properties?.[key] ?? {}, SCHEMA);
}

describe('schema drift', () => {
  it('implements the release the schema $id declares', () => {
    expect(SCHEMA.$id).toContain(`/v${SPEC_VERSION}/`);
  });

  it.each(Object.entries(SHAPES))('the %s object matches the schema', (dotted, shape) => {
    const schema = node(dotted);
    expect([...shape.properties].sort()).toEqual(Object.keys(schema.properties ?? {}).sort());
    expect([...shape.required].sort()).toEqual([...(schema.required ?? [])].sort());
    expect(shape.extensions !== undefined).toBe(schema.patternProperties !== undefined);
  });

  it.each([
    ['emitter.component', EMITTER_COMPONENTS],
    ['resource.type', RESOURCE_TYPES],
    ['resource.operation', OPERATIONS],
    ['resource.modality', MODALITIES],
    ['run.run_type', RUN_TYPES],
    ['run.outcome', RUN_OUTCOMES],
    ['attribution.environment', ENVIRONMENTS],
  ] as const)('the %s enumerants match the schema', (dotted, values) => {
    expect([...values].sort()).toEqual([...(node(dotted).enum ?? [])].sort());
  });
});

// Every bound the schema declares is probed at its limit and one step past it, and the SDK
// must agree with Ajv on both. Strings are filled with a character outside the Basic
// Multilingual Plane, because JSON Schema counts lengths in code points.

interface Bound {
  readonly name: string;
  readonly path: readonly string[];
  readonly within: unknown;
  readonly beyond: unknown;
}

// The prose narrows these to a ULID or a UUIDv7, which the schema's length bounds admit.
const IDENTIFIERS = new Set(['record_id', 'corrects']);
const emoji = (length: number): string => '😀'.repeat(length);

function limits(node: SchemaNode, fill: (length: number) => string): [string, unknown, unknown][] {
  const found: [string, unknown, unknown][] = [];
  if (node.minLength) found.push(['minLength', fill(node.minLength), fill(node.minLength - 1)]);
  if (node.maxLength !== undefined) {
    found.push(['maxLength', fill(node.maxLength), fill(node.maxLength + 1)]);
  }
  if (node.minimum !== undefined) found.push(['minimum', node.minimum, node.minimum - 1]);
  if (node.maximum !== undefined) found.push(['maximum', node.maximum, node.maximum + 1]);
  return found;
}

function bounds(schema: SchemaNode, path: readonly string[] = []): Bound[] {
  const name = path.join('.');
  const found = limits(schema, emoji).map(([keyword, within, beyond]) => ({
    name: `${name} ${keyword}`,
    path,
    within,
    beyond,
  }));
  for (const [keyword, within, beyond] of schema.propertyNames
    ? limits(schema.propertyNames, (length) => 'k'.repeat(length))
    : []) {
    found.push({
      name: `${name} propertyNames ${keyword}`,
      path,
      within: { [within as string]: 'v' },
      beyond: { [beyond as string]: 'v' },
    });
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (path.length > 0 || !IDENTIFIERS.has(key)) found.push(...bounds(child, [...path, key]));
  }
  for (const child of Object.values(schema.patternProperties ?? {})) {
    found.push(...bounds(child, [...path, 'x_probe']));
  }
  if (typeof schema.additionalProperties === 'object') {
    found.push(...bounds(schema.additionalProperties, [...path, 'key']));
  }
  return found;
}

const cost = { total_cost: 1, currency: 'USD' };
const MODEL = makeRecord({ cost: { ...cost, llm: { total_token_cost: 1 } } });
const TOOL = makeRecord({
  resource: { provider: 'self-hosted', type: 'tool', name: 'search', operation: 'retrieval' },
  usage: { tool: { call_count: 1 } },
  cost: { ...cost, tool: { call_cost: 1 } },
});

/** A valid record of the right kind with `value` placed at `path`. */
function place(path: readonly string[], value: unknown): unknown {
  const base: unknown = path[1] === 'tool' ? TOOL : MODEL;
  const record = structuredClone(base) as Record<string, unknown>;
  let parent = record;
  for (const key of path.slice(0, -1)) {
    parent[key] ??= {};
    parent = parent[key] as Record<string, unknown>;
  }
  parent[path.at(-1)!] = value;
  return record;
}

const schemaValidates = new Ajv2020({ strict: false, allErrors: true }).compile(SCHEMA);
const BOUNDS = bounds(SCHEMA);

describe('schema bounds', () => {
  it('finds the bounds the schema declares', () => {
    expect(BOUNDS.map((bound) => bound.name)).toEqual(
      expect.arrayContaining([
        'run.error_reason maxLength',
        'attribution.labels propertyNames maxLength',
        'attribution.labels.key maxLength',
        'usage.tool.x_probe minimum',
        'cost.discount_percent maximum',
      ]),
    );
  });

  it.each(BOUNDS.map((bound) => [bound.name, bound] as const))(
    '%s agrees with the schema',
    (_name, { path, within, beyond }) => {
      const records = [place(path, within), place(path, beyond)];
      expect(records.map((record) => schemaValidates(record))).toEqual([true, false]);
      expect(records.map((record) => validate(record).length === 0)).toEqual([true, false]);
    },
  );
});
