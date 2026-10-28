"""Claude API-ийн алдааг хэрэглэгчид ойлгомжтой Монгол мессеж болгоно — систем гацахгүй."""
from __future__ import annotations


class AIError(Exception):
    """Хэрэглэгчид шууд харуулж болох алдаа. status = HTTP код (frontend-д)."""

    def __init__(self, message: str, status: int = 503, code: str = "ai_error"):
        super().__init__(message)
        self.message, self.status, self.code = message, status, code


NOT_CONFIGURED = AIError("AI тохируулагдаагүй байна (backend/.env-д ANTHROPIC_API_KEY алга). Админд хандана уу.",
                         503, "not_configured")


def translate(e: Exception) -> AIError:
    """anthropic SDK-ийн алдаа → AIError. Нарийнаас өргөн рүү (APITimeoutError нь APIConnectionError-ийн дэд анги)."""
    if isinstance(e, AIError):
        return e
    import anthropic
    if isinstance(e, anthropic.AuthenticationError):
        return AIError("AI түлхүүр (ANTHROPIC_API_KEY) буруу эсвэл хүчингүй байна. Админд хандана уу.", 503, "auth")
    if isinstance(e, anthropic.PermissionDeniedError):
        return AIError("AI түлхүүрт энэ үйлдлийн эрх алга. Админд хандана уу.", 503, "permission")
    if isinstance(e, anthropic.NotFoundError):
        return AIError("AI загвар олдсонгүй — .env-ийн AI_MODEL_* тохиргоог шалгана уу.", 503, "model")
    if isinstance(e, anthropic.RateLimitError):
        return AIError("AI-д хэт олон хүсэлт ирлээ. 1 минутын дараа дахин оролдоно уу.", 429, "rate_limit")
    if isinstance(e, anthropic.APIStatusError):
        kind = getattr(e, "type", "") or ""
        msg = str(getattr(e, "message", "") or e)
        if kind == "billing_error" or e.status_code == 402 or "credit balance" in msg.lower():
            return AIError("AI-ийн кредит дууссан эсвэл төлбөрийн асуудал гарлаа. Админд хандана уу.", 503, "billing")
        if kind == "overloaded_error" or e.status_code == 529:
            return AIError("AI сервер түр ачаалалтай байна. Хэдэн минутын дараа дахин оролдоно уу.", 503, "overloaded")
        if e.status_code == 413 or kind == "request_too_large":
            return AIError("Илгээсэн файл/текст хэт том байна.", 413, "too_large")
        if e.status_code >= 500:
            return AIError("AI серверт түр алдаа гарлаа. Дахин оролдоно уу.", 503, "server")
        return AIError(f"AI хүсэлт амжилтгүй: {msg[:200]}", 502, "bad_request")
    if isinstance(e, anthropic.APITimeoutError):
        return AIError("AI хариу хэт удлаа (timeout). Дахин оролдоно уу.", 504, "timeout")
    if isinstance(e, anthropic.APIConnectionError):
        return AIError("AI серверт холбогдож чадсангүй — интернэт холболтоо шалгана уу.", 503, "connection")
    return AIError(f"AI алдаа: {str(e)[:200]}", 500, "unknown")
