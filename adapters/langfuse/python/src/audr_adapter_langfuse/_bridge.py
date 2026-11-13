"""Bounded handoff from span-ending threads to the AUDR client event loop."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from enum import StrEnum
from threading import Lock

from audr import AUDR, Client, SubmitOutcome

from audr_adapter_langfuse._errors import LangfuseActivationError


class HandoffOutcome(StrEnum):
    """The immediate outcome of scheduling one record."""

    SCHEDULED = "scheduled"
    DROPPED_HANDOFF_FULL = "dropped_handoff_full"
    DROPPED_LOOP_UNAVAILABLE = "dropped_loop_unavailable"


class EventLoopBridge:
    """Move records onto the event loop that owns ``Client``."""

    def __init__(
        self,
        *,
        client: Client,
        loop: asyncio.AbstractEventLoop,
        max_pending: int,
        on_result: Callable[[SubmitOutcome | None], None],
    ) -> None:
        self._client = client
        self._loop = loop
        self._max_pending = max_pending
        self._on_result = on_result
        self._lock = Lock()
        self._pending = 0
        self._drained: asyncio.Future[None] | None = None

    def submit(self, record: AUDR) -> HandoffOutcome:
        """Schedule a non-blocking client submission."""
        with self._lock:
            if self._pending >= self._max_pending:
                return HandoffOutcome.DROPPED_HANDOFF_FULL
            self._pending += 1
        try:
            self._loop.call_soon_threadsafe(self._submit_to_client, record)
        except RuntimeError:
            with self._lock:
                self._pending -= 1
            return HandoffOutcome.DROPPED_LOOP_UNAVAILABLE
        return HandoffOutcome.SCHEDULED

    async def drain(self, timeout: float | None = None) -> None:
        """Wait until all accepted handoffs have called the client."""
        if asyncio.get_running_loop() is not self._loop:
            raise LangfuseActivationError(
                "drain() must run on the event loop that owns the AUDR client"
            )
        with self._lock:
            if self._pending == 0:
                return
            waiter = self._drained
            if waiter is None or waiter.done():
                waiter = self._loop.create_future()
                self._drained = waiter
        try:
            await asyncio.wait_for(asyncio.shield(waiter), timeout)
        except TimeoutError:
            raise TimeoutError("Langfuse adapter drain timed out") from None

    def _submit_to_client(self, record: AUDR) -> None:
        try:
            result = self._client.record(record)
        except Exception:
            self._on_result(None)
        else:
            self._on_result(result.outcome)
        finally:
            self._release_pending()

    def _release_pending(self) -> None:
        with self._lock:
            self._pending -= 1
            waiter = self._drained if self._pending == 0 else None
            if waiter is not None:
                self._drained = None
        if waiter is not None and not waiter.done():
            waiter.set_result(None)


__all__ = ["EventLoopBridge", "HandoffOutcome"]
