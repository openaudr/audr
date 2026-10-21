"""Chargebee-owned conversion of AUDR records into destination usage events.

Chargebee's ingest API accepts only scalar property values, so nested AUDR objects are
flattened here, in the sink, rather than in the AUDR model layer. Nested objects
become ``parent__child`` keys, each ``labels`` entry becomes ``labels__<key>``, and arrays
are stored as canonical JSON under a terminal ``__json`` key so the destination only ever
sees scalars.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import TypeAlias

from audr import AUDR

from audr_sink_chargebee._event_validation import InvalidUsageEventError

_JSON_SUFFIX = "json"
_LABELS_KEY = "labels"
PropertyValue: TypeAlias = str | int | float | bool | None


DEFAULT_SEPARATOR = "__"


def flatten_audr(record: AUDR, *, separator: str = DEFAULT_SEPARATOR) -> dict[str, PropertyValue]:
    """Flatten every field of an AUDR record into Chargebee scalar properties."""
    return flatten(record.to_dict(), separator=separator)


def flatten(
    nested: Mapping[str, object], *, separator: str = DEFAULT_SEPARATOR
) -> dict[str, PropertyValue]:
    """Flatten a nested mapping to Chargebee scalar properties."""
    if not isinstance(nested, Mapping):
        raise InvalidUsageEventError("record must encode to a JSON object")
    flattened: dict[str, PropertyValue] = {}
    _flatten_mapping(nested, (), flattened, separator)
    return flattened


def _flatten_mapping(
    value: Mapping[str, object],
    path: tuple[str, ...],
    output: dict[str, PropertyValue],
    separator: str,
) -> None:
    for key, item in value.items():
        item_path = (*path, key)
        if isinstance(item, Mapping):
            if key == _LABELS_KEY:
                item = _rewrite_label_keys(item, item_path)
            _flatten_mapping(item, item_path, output, separator)
        elif isinstance(item, list | tuple):
            json_key = separator.join((*item_path, _JSON_SUFFIX))
            output[json_key] = _canonical_json(item, item_path)
        elif item is None or isinstance(item, str | int | float | bool):
            output[separator.join(item_path)] = item
        else:
            raise InvalidUsageEventError(f"field at {_pointer(item_path)} is not JSON-encodable")


def _rewrite_label_keys(labels: Mapping[str, object], path: tuple[str, ...]) -> dict[str, object]:
    """Label keys are caller-chosen and may contain ``.`` and ``-``, which Chargebee rejects."""
    rewritten: dict[str, object] = {}
    for key, value in labels.items():
        name = key.replace(".", "_").replace("-", "_")
        if name in rewritten:
            raise InvalidUsageEventError(
                f"labels at {_pointer(path)} collide once '.' and '-' are rewritten to '_'"
            )
        rewritten[name] = value
    return rewritten


def _canonical_json(value: object, path: tuple[str, ...]) -> str:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise InvalidUsageEventError(f"field at {_pointer(path)} is not JSON-encodable") from exc


def _pointer(segments: Sequence[str]) -> str:
    return "/" + "/".join(segment.replace("~", "~0").replace("/", "~1") for segment in segments)
