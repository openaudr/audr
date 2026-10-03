"""Deliver one AUDR record through the Chargebee sink and print the usage event it became.

An `httpx.MockTransport` stands in for the Chargebee ingest endpoint, so the example runs
without network access or credentials. Remove `transport=` to deliver to a real site.
"""

from __future__ import annotations

import asyncio
import json

import audr
import httpx

from audr_sink_chargebee import ChargebeeSink


def chargebee(request: httpx.Request) -> httpx.Response:
    [event] = json.loads(request.content)["events"]
    print(json.dumps(event, indent=2, sort_keys=True))
    return httpx.Response(202)


async def main() -> None:
    record = audr.AUDR(
        timing=audr.Timing(duration_ms=812),
        resource=audr.Resource(
            provider="anthropic",
            type="model",
            name="claude-sonnet-5",
            operation="generation",
            modality="text",
        ),
        usage=audr.Usage(llm=audr.LlmUsage(input_tokens=1200, output_tokens=340, requests=1)),
        run=audr.Run(run_id="01J8ZQ8Y2K3M4N5P6Q7R8S9T0V", span_id="turn-3", run_type="agent_run"),
        attribution=audr.Attribution(
            environment="production",
            account_id="acct_42",
            subscription_id="sub_42",
            labels={"feature": "support-chat"},
        ),
    )

    sink = ChargebeeSink(
        site="acme", api_key="cb_test_key", transport=httpx.MockTransport(chargebee)
    )
    async with audr.Client(
        sink,
        emitter=audr.Emitter(component="harness", name="my-harness", version="1.4.0"),
    ) as client:
        result = client.record(record)
        assert result.queued, result.issues
    print(client.stats)


asyncio.run(main())
