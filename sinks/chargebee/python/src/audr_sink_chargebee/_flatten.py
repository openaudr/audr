"""Chargebee-owned conversion of AUDR records into destination usage events.

Chargebee's ingest API accepts only scalar property values, so nested AUDR objects are
flattened here, in the sink, rather than in the AUDR model layer. Nested objects
become ``parent__child`` keys; arrays and the caller-keyed ``labels`` map are stored as
canonical JSON under a terminal ``__json`` key so the destination only ever sees scalars.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import TypeAlias

from audr import AUDR

from audr_sink_chargebee._event_validation import InvalidUsageEventError

_JSON_SUFFIX = "json"
_JSON_CONTAINER_KEYS = frozenset({"labels"})
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
            if key in _JSON_CONTAINER_KEYS:
                json_key = separator.join((*item_path, _JSON_SUFFIX))
                output[json_key] = _canonical_json(item, item_path)
            else:
                _flatten_mapping(item, item_path, output, separator)
        elif isinstance(item, list | tuple):
            json_key = separator.join((*item_path, _JSON_SUFFIX))
            output[json_key] = _canonical_json(item, item_path)
        elif item is None or isinstance(item, str | int | float | bool):
            output[separator.join(item_path)] = item
        else:
            raise InvalidUsageEventError(f"field at {_pointer(item_path)} is not JSON-encodable")


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
