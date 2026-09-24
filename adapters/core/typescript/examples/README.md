# Examples

Runnable examples against the public `audr` API. From `adapters/core/typescript`:

```bash
make examples   # builds the package, then runs each example with Node's type stripping
```

- `write-to-file.ts` builds one AUDR record and delivers it through `Client` and
  `FileSink` to a local JSON Lines file.
- `decode-json.ts` parses a JSON payload with `decodeRecord`, handling the
  `ValidationError` raised by a deliberately broken (missing `resource.provider`) record.
- `custom-sink.ts` implements a minimal `PrintSink` and checks it against
  `assertSinkContract` from `audr/testing`.

Every example runs offline, against the local filesystem. Each imports the package by its
published name, so it exercises the built `dist/` exactly as a consumer would.
