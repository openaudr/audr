"""Record one LiteLLM completion to a local AUDR JSON Lines file and print the record.

`mock_response` makes LiteLLM return a canned completion with mock usage, so the example
runs without network access or provider keys. Remove it and `api_key` to call the provider.
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import litellm
from audr import Attribution, Client, FileSink

from audr_adapter_litellm import LiteLLMAudrCallback, LiteLLMConfig


async def _wait_for_callback(client: Client, submitted_before: int) -> None:
    """Wait for LiteLLM's non-blocking logging task to invoke the callback."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 5
    while client.stats.submitted == submitted_before and loop.time() < deadline:
        await asyncio.sleep(0.01)
    if client.stats.submitted == submitted_before:
        raise TimeoutError("LiteLLM did not publish usage to the AUDR callback")


async def main() -> None:
    path = Path(tempfile.gettempdir()) / "audr-litellm-example.jsonl"
    path.unlink(missing_ok=True)

    async with Client(FileSink(path)) as client:
        callback = LiteLLMAudrCallback(
            client=client,
            config=LiteLLMConfig(
                attribution_defaults=Attribution(
                    environment="production",
                    account_id="acct_42",
                    labels={"region": "us"},
                )
            ),
        )
        litellm.logging_callback_manager.add_litellm_callback(callback)
        try:
            submitted_before = client.stats.submitted
            await litellm.acompletion(
                model="openai/gpt-4o-mini",
                messages=[{"role": "user", "content": "Where is order 42?"}],
                api_key="mock-key",
                mock_response="Order 42 shipped yesterday.",
                metadata={
                    "audr": {
                        "attribution": {
                            "subscription_id": "sub_7",
                            "labels": {"feature": "support-chat"},
                        },
                        "run": {"run_id": "agent-run-123", "run_type": "agent_run"},
                    }
                },
            )
            await _wait_for_callback(client, submitted_before)
        finally:
            litellm.logging_callback_manager.remove_callback_from_all_lists(callback)
            await callback.drain(timeout=5)
            callback.close()

    # The record's labels hold both the default and the request keys.
    print(path.read_text())


if __name__ == "__main__":
    asyncio.run(main())
