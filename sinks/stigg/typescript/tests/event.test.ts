import { describe, expect, it } from 'vitest';

import {
  createEvent,
  type EventFields,
  formatTimestamp,
  InvalidEventError,
  isEventName,
  MAX_DIMENSIONS_BYTES,
  pointer,
} from '../src/event.js';

const FIELDS: EventFields = {
  eventName: 'ai.usage',
  customerId: 'customer-1',
  resourceId: 'sub_1',
  idempotencyKey: 'rec_1',
  eventTime: '2022-04-29T14:19:51.123Z',
  dimensions: { usage__llm__input_tokens: 1200, resource__name: 'claude' },
};

function reason(fields: Partial<EventFields>): string {
  try {
    createEvent({ ...FIELDS, ...fields });
  } catch (error) {
    if (error instanceof InvalidEventError) return error.message;
    throw error;
  }
  return 'accepted';
}

describe('formatTimestamp', () => {
  it.each([
    ['2022-04-29T14:19:51.123Z', '2022-04-29T14:19:51.123Z'],
    ['2022-04-29T16:19:51.123+02:00', '2022-04-29T14:19:51.123Z'],
    ['2022-04-29T09:19:51.123-05:00', '2022-04-29T14:19:51.123Z'],
    ['2026-10-05T08:00:00Z', '2026-10-05T08:00:00.000Z'],
    ['1969-12-31T23:59:59.999Z', '1969-12-31T23:59:59.999Z'],
  ])('converts %s to the UTC instant %s', (eventTime, expected) => {
    expect(formatTimestamp(eventTime)).toBe(expected);
  });

  it('yields the same string for the same instant every time', () => {
    expect(formatTimestamp(FIELDS.eventTime)).toBe(formatTimestamp(FIELDS.eventTime));
  });

  it.each(['', 'yesterday', '2022-13-45T00:00:00Z', '+010000-01-01T00:00:00Z'])(
    'rejects %j',
    (eventTime) => {
      expect(() => formatTimestamp(eventTime)).toThrow('invalid_timestamp');
    },
  );

  it('rejects a value that is not a string', () => {
    expect(() => formatTimestamp(1651241991123 as unknown as string)).toThrow('invalid_timestamp');
  });
});

describe('isEventName', () => {
  it.each(['ai.usage', 'a', 'x'.repeat(255), 'openrouter.chat.completions.create'])(
    'accepts %j',
    (name) => {
      expect(isEventName(name)).toBe(true);
    },
  );

  it.each([
    '',
    ' ',
    ' ai.usage',
    'ai.usage ',
    'ai.usage\n',
    'x'.repeat(256),
    '$usage.reported',
    '$usage.ingested',
    'usage.credit',
    42,
    undefined,
  ])('rejects %j', (name) => {
    expect(isEventName(name)).toBe(false);
  });
});

describe('createEvent', () => {
  it('maps each field to its Stigg name', () => {
    expect(createEvent(FIELDS)).toEqual({
      eventName: 'ai.usage',
      customerId: 'customer-1',
      resourceId: 'sub_1',
      timestamp: '2022-04-29T14:19:51.123Z',
      idempotencyKey: 'rec_1',
      dimensions: { usage__llm__input_tokens: 1200, resource__name: 'claude' },
    });
  });

  it('omits the resource when the record names none, as Stigg refuses an empty one', () => {
    const event = createEvent({ ...FIELDS, resourceId: undefined });

    expect('resourceId' in event).toBe(false);
  });

  it('returns an event that cannot be changed, and does not alias the input', () => {
    const dimensions = { a: 1 };
    const event = createEvent({ ...FIELDS, dimensions });
    dimensions.a = 2;

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.dimensions)).toBe(true);
    expect(event.dimensions).toEqual({ a: 1 });
  });

  it('rejects an event without a customer', () => {
    expect(reason({ customerId: undefined })).toBe('missing_customer_id');
  });

  it.each(['', ' ', '-leading-dash', 'has space', 'slash/inside', 'x'.repeat(256), 42])(
    'rejects the customer %j',
    (customerId) => {
      expect(reason({ customerId: customerId as unknown as string })).toBe('invalid_customer_id');
    },
  );

  it.each(['a', 'acct_1', 'org|team.1', 'user@example.test', 'x'.repeat(255)])(
    'accepts the customer %j',
    (customerId) => {
      expect(reason({ customerId })).toBe('accepted');
    },
  );

  it.each(['', ' ', 'user@example.test', '_leading', 'x'.repeat(256)])(
    'rejects the resource %j',
    (resourceId) => {
      expect(reason({ resourceId })).toBe('invalid_resource_id');
    },
  );

  it.each(['', ' ', 'x'.repeat(256)])('rejects the idempotency key %j by pointer', (key) => {
    expect(reason({ idempotencyKey: key })).toBe('invalid_field:/record_id');
  });

  it.each(['', 'usage.credit', ' ai.usage'])('rejects the event name %j', (eventName) => {
    expect(reason({ eventName })).toBe('invalid_event_name');
  });

  it('rejects an invalid instant', () => {
    expect(reason({ eventTime: 'soon' })).toBe('invalid_timestamp');
  });

  it.each([
    ['not a number', { bad: Number.NaN }],
    ['infinite', { bad: Number.POSITIVE_INFINITY }],
    ['null', { bad: null }],
    ['an object', { bad: { nested: 1 } }],
    ['an array', { bad: [1] }],
    ['undefined', { bad: undefined }],
  ])('rejects a dimension value that is %s, naming only its path', (_name, dimensions) => {
    expect(reason({ dimensions: dimensions as unknown as EventFields['dimensions'] })).toBe(
      'unencodable_field:/dimensions/bad',
    );
  });

  it('accepts boolean dimension values', () => {
    expect(reason({ dimensions: { cached: true, streamed: false } })).toBe('accepted');
  });

  it('rejects an empty dimension name', () => {
    expect(reason({ dimensions: { '': 1 } })).toBe('unencodable_field:/dimensions/');
  });

  it.each([null, [], 'text'])('rejects dimensions that are %j', (dimensions) => {
    expect(reason({ dimensions: dimensions as unknown as EventFields['dimensions'] })).toBe(
      'unencodable_field:/dimensions',
    );
  });

  it('rejects dimensions larger than Stigg accepts', () => {
    expect(reason({ dimensions: { big: 'x'.repeat(MAX_DIMENSIONS_BYTES) } })).toBe(
      'dimensions_too_large',
    );
  });

  it('accepts an event with no dimensions', () => {
    expect(reason({ dimensions: {} })).toBe('accepted');
  });
});

describe('pointer', () => {
  it('escapes the characters RFC 6901 reserves', () => {
    expect(pointer(['a/b', 'c~d'])).toBe('/a~1b/c~0d');
  });

  it('is empty for the whole document', () => {
    expect(pointer([])).toBe('');
  });
});
