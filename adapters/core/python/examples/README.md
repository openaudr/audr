# Examples

Runnable examples against the public `audr` API. From `adapters/core/python`:

```bash
uv run python examples/write_to_file.py
uv run python examples/from_json.py
uv run python examples/custom_sink.py
```

- `write_to_file.py` builds one AUDR record and delivers it through `Client` and
  `FileSink` to a local JSON Lines file.
- `from_json.py` parses a JSON payload with `AUDR.from_json`, handling the
  `ValidationError` raised by a deliberately broken (missing `resource.provider`) record.
- `custom_sink.py` implements a minimal `PrintSink` and checks it against
  `audr.testing.assert_sink_contract`.

Every example runs offline, against the local filesystem. `make examples` runs all three,
and CI runs them on every supported Python version.
