/**
 * The validator and the record types are generated from `spec/audr.schema.json`, and
 * `make schema-check` fails when the generated files are stale. These tests hold both to the
 * schema: every bound it declares must be accepted at its limit and rejected one step past
 * it, and every object must be typed with its properties, requirements and value types.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { SPEC_VERSION } from '../src/generated-schema.js';
import { makeRecord } from '../src/testing.js';
import { validate } from '../src/validate.js';

interface SchemaNode {
  readonly $id?: string;
  readonly type?: string | readonly string[];
  readonly enum?: readonly string[];
  readonly required?: readonly string[];
  readonly properties?: Record<string, SchemaNode>;
  readonly patternProperties?: Record<string, SchemaNode>;
  readonly additionalProperties?: SchemaNode | boolean;
  readonly propertyNames?: SchemaNode;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

const SCHEMA = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../../spec/audr.schema.json'), 'utf8'),
) as SchemaNode;

it('implements the release the schema $id declares, draft suffix allowed', () => {
  expect(SCHEMA.$id).toMatch(new RegExp(`/v${SPEC_VERSION.replaceAll('.', '\\.')}(-dev)?/`));
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

// The generated types, read back with the compiler and walked beside the schema. The
// conditional rules and the bounds are the validator's alone, so only structure is compared.

interface Member {
  readonly optional: boolean;
  readonly readonly: boolean;
  readonly type: string;
}

interface Shape {
  readonly members: ReadonlyMap<string, Member>;
  readonly index: string | undefined;
}

const EXTENSION_SLOT = 'readonly [key: ExtensionKey]: number | undefined;';
const GENERATED = join(import.meta.dirname, '../src/generated-schema.ts');

function generatedDeclarations(): {
  shapes: ReadonlyMap<string, Shape>;
  unions: ReadonlyMap<string, readonly string[]>;
} {
  const file = ts.createSourceFile(
    GENERATED,
    readFileSync(GENERATED, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const shapes = new Map<string, Shape>();
  const unions = new Map<string, readonly string[]>();
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      const members = new Map<string, Member>();
      let index: string | undefined;
      for (const member of statement.members) {
        if (ts.isPropertySignature(member) && member.type) {
          members.set(member.name.getText(), {
            optional: member.questionToken !== undefined,
            readonly:
              member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false,
            type: member.type.getText(),
          });
        } else if (ts.isIndexSignatureDeclaration(member)) {
          index = member.getText();
        }
      }
      shapes.set(statement.name.text, { members, index });
    } else if (ts.isTypeAliasDeclaration(statement) && ts.isUnionTypeNode(statement.type)) {
      unions.set(
        statement.name.text,
        statement.type.types.map((type) =>
          ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)
            ? type.literal.text
            : type.getText(),
        ),
      );
    }
  }
  return { shapes, unions };
}

const { shapes, unions } = generatedDeclarations();
const typed = new Set<string>();

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

/** Every way `type` differs from `node`, the schema at record path `path`. */
function mismatches(node: SchemaNode, type: string, path: string): string[] {
  const at = path || '/';
  if (node.enum) {
    return sameSet(unions.get(type) ?? [], node.enum) ? [] : [`${at}: ${type} is not the enum`];
  }
  const types = [node.type ?? []].flat();
  if (types.every((each) => each === 'integer' || each === 'number')) {
    return type === 'number' ? [] : [`${at}: ${type} is not number`];
  }
  if (types.length === 1 && types[0] === 'string') {
    return type === 'string' ? [] : [`${at}: ${type} is not string`];
  }
  if (typeof node.additionalProperties === 'object') {
    const value = /^Readonly<Record<string, (\w+)>>$/.exec(type)?.[1];
    return value === undefined
      ? [`${at}: ${type} is not a readonly map`]
      : mismatches(node.additionalProperties, value, `${path}/*`);
  }
  const shape = shapes.get(type);
  if (shape === undefined) return [`${at}: ${type} is not a generated interface`];
  typed.add(type);
  const found: string[] = [];
  const properties = node.properties ?? {};
  const required = new Set(node.required);
  if (node.additionalProperties !== false) found.push(`${at}: open in the schema`);
  if (!sameSet([...shape.members.keys()], Object.keys(properties))) {
    found.push(`${at}: ${type} declares ${[...shape.members.keys()].join(', ')}`);
  }
  for (const [name, child] of Object.entries(properties)) {
    const member = shape.members.get(name);
    if (member === undefined) continue;
    const where = `${path}/${name}`;
    if (!member.readonly) found.push(`${where}: not readonly`);
    if (member.optional === required.has(name)) {
      found.push(`${where}: ${member.optional ? 'optional' : 'required'}, unlike the schema`);
    }
    const own = member.optional ? member.type.replace(/ \| undefined$/, '') : member.type;
    if (member.optional && own === member.type) found.push(`${where}: rejects undefined`);
    found.push(...mismatches(child, own, where));
  }
  const slots = Object.values(node.patternProperties ?? {});
  if (shape.index !== (slots.length > 0 ? EXTENSION_SLOT : undefined)) {
    found.push(`${at}: index signature ${shape.index ?? 'missing'}`);
  }
  for (const slot of slots) found.push(...mismatches(slot, 'number', `${path}/x_*`));
  return found;
}

const MISMATCHES = mismatches(SCHEMA, 'AudrRecordShape', '');

describe('generated types', () => {
  it('type every schema object with its properties, requirements and value types', () => {
    expect(MISMATCHES).toEqual([]);
  });

  it('declare no interface the schema does not define', () => {
    expect([...typed].sort()).toEqual([...shapes.keys()].sort());
  });
});
