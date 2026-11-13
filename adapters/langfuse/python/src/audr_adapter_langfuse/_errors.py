"""Public errors and stable record error codes."""

from enum import StrEnum

from audr import LifecycleError


class LangfuseActivationError(LifecycleError):
    """The processor was constructed or used with an invalid lifecycle."""


class LangfuseRunErrorCode(StrEnum):
    """Machine-stable Langfuse failures written to ``run.error_code``."""

    OBSERVATION_ERROR = "LANGFUSE_OBSERVATION_ERROR"


__all__ = ["LangfuseActivationError", "LangfuseRunErrorCode"]
