"""Typed errors. Every HTTP failure carries the status code and the parsed body."""

from __future__ import annotations

from typing import Any


class BazaarError(Exception):
    """Base class for every error raised by this package."""

    def __init__(self, message: str, status: int | None = None, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class NoPaymentMethodError(BazaarError):
    """`call()` needs a credit token or a private key; neither was configured."""


class BadRequestError(BazaarError):
    """400: the server rejected the input. You were not charged."""


class NotFoundError(BazaarError):
    """404: unknown service id."""


class PaymentRequiredError(BazaarError):
    """402: payment is required, or the payment / credit token was refused.

    `reason` is the server's or facilitator's explanation when one was given
    (e.g. "Insufficient credits", or an x402 verification error such as
    "invalid_payload: ..."). `requirements` is the decoded x402 challenge when
    the response carried one.
    """

    def __init__(
        self,
        message: str,
        status: int | None = 402,
        body: Any = None,
        reason: str | None = None,
        requirements: dict | None = None,
    ) -> None:
        super().__init__(message, status, body)
        self.reason = reason
        self.requirements = requirements


class PriceTooHighError(BazaarError):
    """The quoted price exceeds the client's `max_price_usd`; nothing was signed."""


class RateLimitError(BazaarError):
    """429: back off. `retry_after` is in seconds when the server sent it."""

    def __init__(self, message: str, status: int | None = 429, body: Any = None, retry_after: float | None = None) -> None:
        super().__init__(message, status, body)
        self.retry_after = retry_after


class ConflictError(BazaarError):
    """409: the payment was already used / is being processed. Not charged twice."""


class ServerError(BazaarError):
    """5xx: upstream or server failure. The server does not settle payment on these."""
