/**
 * A sentinel placed in every payload field the exporter must not read must reach no record
 * and no log line.
 */
import { describe, expect, it } from 'vitest';

import { ended, harness, modelSpan, toolSpan } from './helpers.js';

const SENTINEL = 'SENTINEL-7f3a9c';

describe('no payloads, no values in diagnostics', () => {
  it('sentinel in span payloads reaches no record and no log line', async () => {
    const h = harness({ attributionDefaults: { environment: 'test' } });
    const span = modelSpan({
      input: SENTINEL,
      output: SENTINEL,
      requestContext: { audr: { environment: 'test' }, secret: SENTINEL },
      errorInfo: { message: SENTINEL, details: { note: SENTINEL } },
      metadata: {
        audr: { environment: 'test' },
        other: SENTINEL,
      },
      attributes: {
        provider: 'openai.chat',
        model: 'gpt-5.4',
        parameters: { temperature: SENTINEL },
        usage: { inputTokens: 3, outputTokens: 2 },
      },
    });
    await h.exporter.exportTracingEvent(ended(span));
    await h.exporter.exportTracingEvent(
      ended(
        toolSpan({
          input: SENTINEL,
          output: SENTINEL,
          metadata: { audr: { environment: 'test' }, leak: SENTINEL },
        }),
      ),
    );
    const records = await h.records();
    const blob = JSON.stringify(records) + h.logger.lines.join('\n');
    expect(blob).not.toContain(SENTINEL);
  });
});
