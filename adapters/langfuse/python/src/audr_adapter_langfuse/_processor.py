"""OpenTelemetry span processor that meters ended Langfuse observations."""

from __future__ import annotations

import asyncio
import logging
from threading import Lock
from typing import assert_never

from audr import AUDR, Client, SubmitOutcome
from opentelemetry.context import Context
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor

from audr_adapter_langfuse._bridge import EventLoopBridge, HandoffOutcome
from audr_adapter_langfuse._config import LangfuseConfig
from audr_adapter_langfuse._errors import LangfuseActivationError
from audr_adapter_langfuse._mapping import (
    RecordMalformed,
    RecordReady,
    RecordSkipped,
    map_span,
)

_LOGGER = logging.getLogger(__name__)
# Skips that are expected for ordinary traffic and would only add noise: spans that are
# not metered observations, and generations that reported no usage, such as streams
# without usage or the OpenAI wrapper's failure path.
_QUIET_SKIPS = frozenset(
    {"/attributes/langfuse.observation.type", "/attributes/langfuse.observation.usage_details"}
)


class LangfuseAudrProcessor(SpanProcessor):
    """Emit metered Langfuse observations through a host-owned AUDR client.

    Add this processor to the ``TracerProvider`` the Langfuse client uses.
    Construct it on the running event loop that owns ``client``. Spans end on
    whichever thread ran the observed work; the bounded bridge returns each
    record to the owning loop without blocking that thread.
    """

    def __init__(
        self,
        *,
        client: Client,
        config: LangfuseConfig | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        if loop is None:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError as error:
                raise LangfuseActivationError(
                    "construct LangfuseAudrProcessor on the running event loop that owns "
                    "the AUDR client, or pass loop= explicitly"
                ) from error
        if loop.is_closed() or not loop.is_running():
            raise LangfuseActivationError("the Langfuse processor event loop must be running")
        self._config = config or LangfuseConfig()
        self._bridge = EventLoopBridge(
            client=client,
            loop=loop,
            max_pending=self._config.max_pending_handoffs,
            on_result=self._on_submit_result,
        )
        self._closed = False
        # Parents of model spans that already produced a record. Integrations nest one model
        # call inside another (the `langfuse.openai` drop-in patches the OpenAI SDK that
        # LangChain's ChatOpenAI calls), so such a parent repeats its child's usage. A dict
        # keeps insertion order, so the oldest entry is evicted when full: a parent that
        # ended before its child is never taken and would otherwise stay forever.
        self._billed_parents: dict[tuple[int, int], None] = {}
        self._billed_parents_lock = Lock()

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        """Do nothing: every metered value is final only when the span ends."""

    def on_end(self, span: ReadableSpan) -> None:
        """Map one ended span and hand any record to the client's loop."""
        if self._closed:
            _LOGGER.warning("Langfuse span ignored: adapter is closed")
            return
        child_billed = self._take_billed(span)
        try:
            result = map_span(
                span,
                attribution_defaults=self._config.attribution_defaults,
                provider=self._config.provider,
            )
        except Exception:
            _LOGGER.warning("Langfuse span mapping failed internally")
            return

        match result:
            case RecordReady(record=record):
                if record.resource.type == "model":
                    if child_billed:
                        return
                    self._mark_parent_billed(span)
                self._submit(record)
            case RecordSkipped(path=path):
                if path not in _QUIET_SKIPS:
                    _LOGGER.warning("Langfuse span skipped (path=%s)", path)
            case RecordMalformed(path=path):
                _LOGGER.warning("Langfuse span malformed (path=%s)", path)
            case unreachable:
                assert_never(unreachable)

    def _take_billed(self, span: ReadableSpan) -> bool:
        """Report and forget whether a model child of this span produced a record."""
        if span.context is None:
            return False
        key = (span.context.trace_id, span.context.span_id)
        with self._billed_parents_lock:
            if key not in self._billed_parents:
                return False
            del self._billed_parents[key]
            return True

    def _mark_parent_billed(self, span: ReadableSpan) -> None:
        # A remote parent never ends in this process, so remembering it would only leak.
        if span.parent is None or span.parent.is_remote:
            return
        key = (span.parent.trace_id, span.parent.span_id)
        with self._billed_parents_lock:
            if key not in self._billed_parents and (
                len(self._billed_parents) >= self._config.max_tracked_spans
            ):
                del self._billed_parents[next(iter(self._billed_parents))]
            self._billed_parents[key] = None

    def shutdown(self) -> None:
        """Do nothing: a shut-down provider ends no more spans, and ``drain()`` must still work."""

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        """Return at once: records are handed off synchronously in ``on_end``."""
        return True

    async def drain(self, timeout: float | None = None) -> None:
        """Wait until all records accepted by the bridge reach the client."""
        if self._closed:
            raise LangfuseActivationError("drain() must be awaited before close()")
        await self._bridge.drain(timeout)

    def close(self) -> None:
        """Stop accepting spans after the Langfuse client has flushed."""
        self._closed = True

    def _submit(self, record: AUDR) -> None:
        outcome = self._bridge.submit(record)
        match outcome:
            case HandoffOutcome.SCHEDULED:
                return
            case HandoffOutcome.DROPPED_HANDOFF_FULL:
                _LOGGER.warning("Langfuse span record dropped: handoff full")
            case HandoffOutcome.DROPPED_LOOP_UNAVAILABLE:
                _LOGGER.warning("Langfuse span record dropped: event loop unavailable")
            case unreachable:
                assert_never(unreachable)

    def _on_submit_result(self, outcome: SubmitOutcome | None) -> None:
        if outcome is SubmitOutcome.QUEUED:
            return
        if outcome is None:
            _LOGGER.warning("Langfuse span record submission failed")
        else:
            _LOGGER.warning("Langfuse span record submission dropped (outcome=%s)", outcome)


__all__ = ["LangfuseAudrProcessor"]
