"""Record one Langfuse generation and one tool call to a local AUDR JSON Lines file.

The Langfuse client exports to an in-memory exporter, so the example runs without network
access or Langfuse keys. Remove `span_exporter` and use real keys to send traces to Langfuse.
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from audr import Attribution, Client, FileSink
from langfuse import Langfuse, propagate_attributes
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from audr_adapter_langfuse import LangfuseAudrProcessor, LangfuseConfig


async def main() -> None:
    path = Path(tempfile.gettempdir()) / "audr-langfuse-example.jsonl"
    path.unlink(missing_ok=True)

    async with Client(FileSink(path)) as client:
        processor = LangfuseAudrProcessor(
            client=client,
            config=LangfuseConfig(
                provider="openai",
                attribution_defaults=Attribution(environment="production"),
            ),
        )
        tracer_provider = TracerProvider()
        tracer_provider.add_span_processor(processor)
        langfuse = Langfuse(
            public_key="pk-lf-example",
            secret_key="sk-lf-example",
            tracer_provider=tracer_provider,
            span_exporter=InMemorySpanExporter(),
        )
        try:
            with (
                langfuse.start_as_current_observation(name="support-agent", as_type="agent"),
                propagate_attributes(
                    metadata={
                        "audr_account_id": "acct_42",
                        "audr_subscription_id": "sub_7",
                        "audr_feature_id": "support-chat",
                    }
                ),
            ):
                with langfuse.start_as_current_observation(
                    name="answer", as_type="generation", model="gpt-4o-mini"
                ) as generation:
                    generation.update(usage_details={"input": 120, "output": 40})
                with langfuse.start_as_current_observation(name="lookup_order", as_type="tool"):
                    pass
        finally:
            langfuse.shutdown()
            await processor.drain(timeout=5)
            processor.close()

    print(path.read_text())


if __name__ == "__main__":
    asyncio.run(main())
