"""Langfuse integration for attributed AUDR usage."""

from importlib import import_module
from typing import TYPE_CHECKING

from audr_adapter_langfuse._config import LangfuseConfig
from audr_adapter_langfuse._errors import LangfuseActivationError, LangfuseRunErrorCode
from audr_adapter_langfuse._version import __version__

if TYPE_CHECKING:
    from audr_adapter_langfuse._processor import LangfuseAudrProcessor

__all__ = [
    "LangfuseActivationError",
    "LangfuseAudrProcessor",
    "LangfuseConfig",
    "LangfuseRunErrorCode",
    "__version__",
]


def __getattr__(name: str) -> object:
    """Load the OpenTelemetry-dependent processor only when it is activated."""
    if name != "LangfuseAudrProcessor":
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    try:
        module = import_module("audr_adapter_langfuse._processor")
    except ModuleNotFoundError as error:
        if error.name is None or not error.name.startswith("opentelemetry"):
            raise
        raise LangfuseActivationError(
            "Langfuse is required to activate the processor; install the runtime extra"
        ) from error
    processor: object = getattr(module, name)
    return processor
