"""Record the metered result of a LiteLLM Router fallback chain.

`mock_testing_fallbacks` makes the primary deployment fail and `mock_response` answers
from the fallback, so the example runs without network access or provider keys. The
unmetered failed attempt produces no record; the fallback produces one.
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import litellm
from audr import Attribution, Client, FileSink
from litellm.router import Router

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
    router = Router(
        model_list=[
            {
                "model_name": "primary",
                "litellm_params": {"model": "openai/gpt-4o-mini", "api_key": "mock-key"},
            },
            {
                "model_name": "fallback",
                "litellm_params": {"model": "anthropic/claude-haiku-4-5", "api_key": "mock-key"},
            },
        ],
        fallbacks=[{"primary": ["fallback"]}],
        num_retries=0,
    )
    path = Path(tempfile.gettempdir()) / "audr-litellm-router-example.jsonl"
    path.unlink(missing_ok=True)

    async with Client(FileSink(path)) as client:
        callback = LiteLLMAudrCallback(
            client=client,
            config=LiteLLMConfig(
                attribution_defaults=Attribution(
                    environment="production",
                    account_id="acct_42",
                    subscription_id="sub_7",
                )
            ),
        )
        litellm.logging_callback_manager.add_litellm_callback(callback)
        try:
            submitted_before = client.stats.submitted
            await router.acompletion(
                model="primary",
                messages=[{"role": "user", "content": "Summarize AUDR in one sentence."}],
                mock_testing_fallbacks=True,
                mock_response="AUDR is one usage record per metered agent operation.",
                metadata={"audr": {"run": {"run_id": "router-run-1", "run_type": "agent_run"}}},
            )
            await _wait_for_callback(client, submitted_before)
        finally:
            litellm.logging_callback_manager.remove_callback_from_all_lists(callback)
            await callback.drain(timeout=5)
            callback.close()
            router.reset()  # type: ignore[no-untyped-call]

    print(path.read_text())


if __name__ == "__main__":
    asyncio.run(main())
