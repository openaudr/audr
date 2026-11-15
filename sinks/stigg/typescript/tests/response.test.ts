import { describe, expect, it } from 'vitest';

import { classifyStatus, parseValidationErrors, type StatusClass } from '../src/response.js';

describe('classifyStatus', () => {
  it.each<[number, StatusClass]>([
    [202, 'accepted'],
    [200, 'accepted'],
    [400, 'invalid'],
    [401, 'credential'],
    [403, 'forbidden'],
    [413, 'too_large'],
    [408, 'transient'],
    [409, 'transient'],
    [429, 'transient'],
    [500, 'transient'],
    [502, 'transient'],
    [503, 'transient'],
    [504, 'transient'],
    [599, 'transient'],
    [404, 'permanent'],
    [422, 'permanent'],
    [301, 'permanent'],
    [302, 'permanent'],
    [307, 'permanent'],
    [201, 'unconfirmed'],
    [204, 'unconfirmed'],
    [299, 'unconfirmed'],
    [300, 'permanent'],
    [100, 'permanent'],
    [600, 'permanent'],
  ])('maps %i to %s', (status, expected) => {
    expect(classifyStatus(status)).toBe(expected);
  });
});

/** A `400` body as Stigg's validation pipe writes it. */
const body = (message: string, code: unknown = 'BadUserInput'): unknown => ({ code, message });

describe('parseValidationErrors', () => {
  it('names the event and field a schema issue points at', () => {
    expect(
      parseValidationErrors(
        body('Validation error: String must match pattern at "events[2].customerId"'),
        3,
      ),
    ).toEqual([{ index: 2, detail: 'bad_user_input:customerId' }]);
  });

  it('reads every issue of a message, in request order', () => {
    expect(
      parseValidationErrors(
        body(
          'Validation error: Invalid datetime at "events[3].timestamp"; ' +
            'Required at "events[0].idempotencyKey"',
        ),
        4,
      ),
    ).toEqual([
      { index: 0, detail: 'bad_user_input:idempotencyKey' },
      { index: 3, detail: 'bad_user_input:timestamp' },
    ]);
  });

  it('keeps the first field named when an event is named twice', () => {
    expect(
      parseValidationErrors(
        body('Validation error: x at "events[1].eventName"; y at "events[1].dimensions.k"'),
        2,
      ),
    ).toEqual([{ index: 1, detail: 'bad_user_input:eventName' }]);
  });

  it('names an event without a field, such as for an unrecognized key', () => {
    expect(
      parseValidationErrors(body('Validation error: Unrecognized key(s) at "events[0]"'), 1),
    ).toEqual([{ index: 0, detail: 'bad_user_input' }]);
  });

  it('never surfaces a field name outside the allowlist', () => {
    expect(
      parseValidationErrors(body('Validation error: x at "events[0].secretValue"'), 1),
    ).toEqual([{ index: 0, detail: 'bad_user_input' }]);
  });

  it.each([
    ['a body that is not an object', 'text'],
    ['an array', []],
    ['null', null],
    ['another error code', body('x at "events[0].customerId"', 'InvalidArgument')],
    ['a missing code', { message: 'x at "events[0].customerId"' }],
    ['a message that is not a string', { code: 'BadUserInput', message: 42 }],
    ['a message naming no event', body('Validation error: Required at "events"')],
    ['a reserved event name, refused without a position', body('Event name x is reserved')],
    ['an index outside the request', body('x at "events[2].customerId"')],
    ['an index with a leading zero', body('x at "events[01].customerId"')],
  ])('distrusts %s', (_name, response) => {
    expect(parseValidationErrors(response, 2)).toBeUndefined();
  });

  it('distrusts the whole message when any index falls outside the request', () => {
    expect(
      parseValidationErrors(body('a at "events[0].customerId"; b at "events[5].timestamp"'), 2),
    ).toBeUndefined();
  });
});
