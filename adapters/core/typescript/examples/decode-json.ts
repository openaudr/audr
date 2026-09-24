/**
 * Parse a JSON-encoded AUDR record, handling `ValidationError`. The payload deliberately
 * omits `resource.provider` to exercise the error path.
 */
import { decodeRecord, SPEC_VERSION, ValidationError } from 'audr';

const payload = JSON.stringify({
  spec_version: SPEC_VERSION,
  record_id: '01J8ZQ8Y2K3M4N5P6Q7R8S9T0V',
  emitter: { component: 'harness', name: 'example', version: '1' },
  timing: { event_time: '2026-01-01T00:00:00.000Z' },
  resource: { type: 'model', name: 'claude-sonnet-5', operation: 'generation', modality: 'text' },
  usage: { llm: { input_tokens: 10, output_tokens: 5, requests: 1 } },
  run: { run_id: '01J8ZQ8Y2K3M4N5P6Q7R8S9T0V', span_id: 'turn-3' },
  attribution: { environment: 'test' },
});

try {
  const record = decodeRecord(payload);
  console.log('parsed record', record.record_id);
} catch (error) {
  if (!(error instanceof ValidationError)) throw error;
  for (const issue of error.issues) {
    console.log(`bad AUDR record: code=${issue.code} path=${issue.path}`);
  }
}
