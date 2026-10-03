"""HTTP sink for Chargebee's usage-ingest batch endpoint."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import httpx
from audr import AUDR, BatchResult, ConfigurationError, RejectedRecord

from audr_sink_chargebee._credentials import resolve_credentials
from audr_sink_chargebee._event import UsageEvent
from audr_sink_chargebee._event_validation import InvalidUsageEventError
from audr_sink_chargebee._flatten import DEFAULT_SEPARATOR, flatten_audr
from audr_sink_chargebee._retry import FailureClass, RetryPolicy
from audr_sink_chargebee._transport import (
    HttpTransportConfig,
    _ClientClosedError,
    _LazyAsyncHttpClient,
)
from audr_sink_chargebee._version import __version__

_LOGGER = logging.getLogger(__name__)

_ACCEPTED_STATUS_CODES = frozenset({202, 207})
_USER_AGENT = f"audr-ingestion-python/{__version__}"

# Chargebee property names must match [a-zA-Z][a-zA-Z0-9_]*, so the separator
# used to join flattened path segments may only be one or more underscores.
_SEPARATOR_PATTERN = re.compile(r"^_+$")


@dataclass(frozen=True, slots=True)
class _SendOutcome:
    """The result of one delivery attempt against the ingest endpoint."""

    ok: bool
    closed: bool = False
    rejected: tuple[RejectedRecord, ...] = ()
    unknown: tuple[str, ...] = ()
    retryable: bool = False
    detail: str | None = None


class ChargebeeSink:
    """Deliver AUDR records to a single validated Chargebee ingest origin."""

    def __init__(
        self,
        *,
        site: str | None = None,
        api_key: str | None = None,
        ingest_domain: str | None = None,
        ingest_url: str | None = None,
        retry: RetryPolicy | None = None,
        http: HttpTransportConfig | None = None,
        separator: str = DEFAULT_SEPARATOR,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        if not _SEPARATOR_PATTERN.fullmatch(separator):
            raise ConfigurationError(
                "separator must consist of one or more underscores; Chargebee property "
                "names must start with a letter and contain only letters, digits, and "
                "underscores"
            )
        self._endpoint, self._api_key = resolve_credentials(
            site=site,
            api_key=api_key,
            ingest_domain=ingest_domain,
            ingest_url=ingest_url,
        )
        self._separator = separator
        self._retry_policy = retry or RetryPolicy()
        self._sleep = sleep
        self._http_client = _LazyAsyncHttpClient(
            config=http or HttpTransportConfig(),
            transport=transport,
        )

    async def deliver(self, batch: Sequence[AUDR]) -> BatchResult:
        """Deliver a batch in one request, returning failures as a typed outcome.

        The batch is sent whole. Chargebee owns the request-size limit, so a
        batch it judges too large comes back as a permanent failure with
        ``detail="payload_too_large"``; bound the records per request with
        ``Client(batch_max_size=...)``. When a `207` body contains a failed
        event that cannot be matched back to a record in the batch, every
        non-rejected record is conservatively reported as ``unknown`` rather
        than assumed accepted, since replay is idempotent on `record_id`.
        """
        if self._http_client.closed:
            return BatchResult.closed()
        if not batch:
            return BatchResult.accepted()

        rejected: list[RejectedRecord] = []
        events: list[UsageEvent] = []
        for record in batch:
            subscription_id = record.attribution.subscription_id
            if not subscription_id:
                rejected.append(RejectedRecord(record.record_id, "missing_subscription_id"))
                continue
            try:
                events.append(_build_event(record, subscription_id, self._separator))
            except InvalidUsageEventError as error:
                rejected.append(RejectedRecord(record.record_id, str(error)))

        if not events:
            return BatchResult.accepted(rejected=rejected)

        outcome = await self._send_batch(events, self._headers())
        if outcome.closed:
            return BatchResult.closed()
        if not outcome.ok:
            return BatchResult.failed(retryable=outcome.retryable, detail=outcome.detail)

        rejected.extend(outcome.rejected)
        return BatchResult.accepted(rejected=rejected, unknown=outcome.unknown)

    async def close(self) -> None:
        """Close the shared HTTP client once; shutdown failures are logged only."""
        try:
            await self._http_client.close()
        except Exception:
            _LOGGER.exception(
                "Failed to close Chargebee usage sink for origin %s",
                self._endpoint.origin,
            )

    def __repr__(self) -> str:
        return f"ChargebeeSink(origin={self._endpoint.origin!r})"

    def _headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Authorization": self._api_key.basic_auth_header(),
            "Content-Type": "application/json;charset=UTF-8",
            "User-Agent": _USER_AGENT,
        }

    async def _send_batch(
        self,
        events: Sequence[UsageEvent],
        headers: Mapping[str, str],
    ) -> _SendOutcome:
        body = _encode_batch(events)
        url = f"{self._endpoint.origin}/api/v2/batch/usage_events"

        for attempt in range(1, self._retry_policy.max_attempts + 1):
            try:
                response = await self._http_client.post(url, content=body, headers=headers)
            except _ClientClosedError:
                _LOGGER.warning("Chargebee usage sink is closed; batch not delivered")
                return _SendOutcome(ok=False, closed=True)
            except httpx.RequestError as error:
                # Connection, timeout, and protocol errors never carry a destination
                # verdict, so they are always retried within the policy's budget.
                if attempt == self._retry_policy.max_attempts:
                    return _SendOutcome(ok=False, retryable=True, detail=type(error).__name__)
                await self._sleep(self._retry_policy.delay_for(attempt))
                continue

            if response.status_code in _ACCEPTED_STATUS_CODES:
                return self._success_outcome(events, response)

            if response.status_code == 413:
                # The destination owns the request-size limit; the caller's remedy is
                # fewer records per request.
                _LOGGER.warning(
                    "Chargebee rejected the batch as too large (batch_size=%s); "
                    "lower Client(batch_max_size=...)",
                    len(events),
                )
                return _SendOutcome(ok=False, retryable=False, detail="payload_too_large")

            failure_class = self._retry_policy.classify(response.status_code)
            if failure_class is FailureClass.TRANSIENT:
                if attempt == self._retry_policy.max_attempts:
                    return _SendOutcome(
                        ok=False,
                        retryable=True,
                        detail=f"http_{response.status_code}",
                    )
                await self._sleep(
                    self._retry_policy.delay_for(attempt, response.headers.get("Retry-After"))
                )
                continue

            if failure_class is FailureClass.CREDENTIAL:
                _LOGGER.error(
                    "Chargebee site key was rejected for origin %s (status %s)",
                    self._endpoint.origin,
                    response.status_code,
                )
                return _SendOutcome(ok=False, retryable=False, detail="auth")

            _LOGGER.warning(
                "Chargebee batch rejected permanently (status=%s)",
                response.status_code,
            )
            return _SendOutcome(ok=False, retryable=False, detail=f"http_{response.status_code}")

        raise AssertionError("retry policy must allow at least one attempt")

    def _success_outcome(
        self,
        events: Sequence[UsageEvent],
        response: httpx.Response,
    ) -> _SendOutcome:
        if response.status_code == 202:
            return _SendOutcome(ok=True)

        try:
            payload = response.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            payload = None
        if not isinstance(payload, Mapping) or not isinstance(payload.get("failed_events"), list):
            _LOGGER.warning(
                "Chargebee partial response was unparseable; event outcomes are unknown "
                "(batch_size=%s)",
                len(events),
            )
            return _SendOutcome(
                ok=True,
                unknown=tuple(event.deduplication_id for event in events),
            )

        ids_in_batch: dict[str, int] = {}
        for event in events:
            ids_in_batch[event.deduplication_id] = ids_in_batch.get(event.deduplication_id, 0) + 1

        rejected: list[RejectedRecord] = []
        rejected_ids: set[str] = set()
        unattributed_count = 0
        for raw_rejection in payload["failed_events"]:
            if not isinstance(raw_rejection, Mapping):
                unattributed_count += 1
                continue
            identifier = raw_rejection.get("deduplication_id")
            if not isinstance(identifier, str):
                unattributed_count += 1
                continue
            occurrences = ids_in_batch.get(identifier)
            if not occurrences or identifier in rejected_ids:
                unattributed_count += 1
                continue
            rejected_ids.add(identifier)
            error_code = _first_error_code(raw_rejection)
            rejected.extend(RejectedRecord(identifier, error_code) for _ in range(occurrences))

        if unattributed_count:
            _LOGGER.warning(
                "Chargebee batch had %s unattributable failed_events rejection(s) (batch_size=%s)",
                unattributed_count,
                len(events),
            )
            unknown = tuple(
                event.deduplication_id
                for event in events
                if event.deduplication_id not in rejected_ids
            )
        else:
            unknown = ()

        return _SendOutcome(ok=True, rejected=tuple(rejected), unknown=unknown)


def _build_event(record: AUDR, subscription_id: str, separator: str) -> UsageEvent:
    return UsageEvent(
        subscription_id=subscription_id,
        usage_timestamp=record.event_time_ms,
        deduplication_id=record.record_id,
        properties=flatten_audr(record, separator=separator),
    )


def _encode_batch(batch: Sequence[UsageEvent]) -> bytes:
    payload = {"events": [event.to_payload() for event in batch]}
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def _first_error_code(payload: Mapping[str, Any]) -> str | None:
    for field in ("api_error_code", "error_code", "code"):
        value = payload.get(field)
        if value is not None:
            return str(value)
    return None
