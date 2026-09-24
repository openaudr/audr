"""Attribution resolution for Relay scopes.

Relay scope metadata carries AUDR attribution under the ``audr`` namespace.
Resolving it is per-scope runtime work, distinct from the component configuration
parsed once at activation.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Final

from audr import Attribution, ErrorCode
from pydantic import ValidationError

_ATTRIBUTION_FIELDS = frozenset(Attribution.model_fields)
_NON_EMPTY_ATTRIBUTION_FIELDS = ("account_id", "subscription_id", "user_id")
_METADATA_NAMESPACE: Final = "audr"


def resolve_attribution(
    *,
    defaults: Attribution,
    metadata: object,
) -> tuple[Attribution | None, str | None]:
    """Merge root ``audr`` metadata over static defaults.

    Returns the billable attribution, or a JSON Pointer naming what stopped it
    from resolving. ``subscription_id`` is not required here: that is a
    Chargebee sink rule, not a core AUDR one.
    """
    overrides, issue = _audr_overrides(metadata)
    if issue is not None:
        return None, issue

    try:
        supplied = Attribution.model_validate(dict(overrides))
    except ValidationError as error:
        return None, _metadata_pointer(error)
    field_name = attribution_shape_issue(supplied)
    if field_name is not None:
        return None, f"/metadata/{_METADATA_NAMESPACE}/{field_name}"

    merged = _attribution_to_dict(defaults)
    merged.update({key: overrides[key] for key in _ATTRIBUTION_FIELDS if key in overrides})
    try:
        attribution = Attribution.model_validate(merged)
    except ValidationError as error:
        return None, _attribution_pointer(error)
    completeness_issues = attribution.validate()
    if completeness_issues:
        return None, completeness_issues[0].path
    return attribution, None


def attribution_shape_issue(attribution: Attribution) -> str | None:
    """Return the name of the first field the integration cannot bill on.

    This checks field *shape* only, not billing completeness: a partial
    ``attribution_defaults`` or a metadata override may omit ``environment``
    entirely and rely on the other side of the merge to supply it, so the
    ``REQUIRED`` issues :meth:`Attribution.validate` reports for a still-partial
    value are not reported here.
    """
    for candidate_issue in attribution.validate():
        if candidate_issue.code is ErrorCode.NON_PSEUDONYMOUS_ID:
            return candidate_issue.path.rsplit("/", 1)[-1]
    for name in _NON_EMPTY_ATTRIBUTION_FIELDS:
        if getattr(attribution, name) == "":
            return name
    return None


def _audr_overrides(metadata: object) -> tuple[Mapping[str, object], str | None]:
    if metadata is None:
        return {}, None
    if not isinstance(metadata, Mapping):
        return {}, "/metadata"
    namespace = metadata.get(_METADATA_NAMESPACE)
    if namespace is None:
        return {}, None
    if not isinstance(namespace, Mapping):
        return {}, f"/metadata/{_METADATA_NAMESPACE}"
    return namespace, None


def _metadata_pointer(error: ValidationError) -> str:
    field_name = _first_field(error)
    suffix = f"/{field_name}" if field_name else ""
    return f"/metadata/{_METADATA_NAMESPACE}{suffix}"


def _attribution_pointer(error: ValidationError) -> str:
    field_name = _first_field(error)
    return f"/attribution/{field_name}" if field_name else "/attribution"


def _first_field(error: ValidationError) -> str | None:
    loc = error.errors(include_url=False, include_input=False)[0]["loc"]
    name = str(loc[0]) if loc else None
    return name if name in _ATTRIBUTION_FIELDS else None


def _attribution_to_dict(attribution: Attribution) -> dict[str, object]:
    values: dict[str, object] = {
        name: getattr(attribution, name)
        for name in _ATTRIBUTION_FIELDS - {"labels"}
        if getattr(attribution, name) is not None
    }
    if attribution.labels:
        values["labels"] = dict(attribution.labels)
    return values


__all__ = [
    "attribution_shape_issue",
    "resolve_attribution",
]
