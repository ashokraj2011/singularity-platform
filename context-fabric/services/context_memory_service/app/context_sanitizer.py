import re


FILLER_PHRASES = [
    r"\bsure\b",
    r"\bokay\b",
    r"\bok\b",
    r"\bgot it\b",
    r"\babsolutely\b",
    r"\bas mentioned earlier\b",
    r"\bas discussed\b",
    r"\bhere is\b",
    r"\bhere are\b",
    r"\bbasically\b",
    r"\bactually\b",
    r"\bkind of\b",
    r"\bsort of\b",
    r"\bin order to\b",
    r"\bdue to the fact that\b",
    r"\bplease note that\b",
    r"\blet me know\b",
]

PROTECTED_TERMS = {
    "not",
    "never",
    "unless",
    "except",
    "only",
    "before",
    "after",
    "must",
    "should",
    "required",
    "forbidden",
    "if",
    "else",
    "and",
    "or",
    "all",
    "any",
    "none",
}


def remove_filler_phrases(text: str) -> str:
    cleaned = text

    for phrase in FILLER_PHRASES:
        cleaned = re.sub(phrase, "", cleaned, flags=re.IGNORECASE)

    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)

    return cleaned.strip()


def remove_duplicate_lines(text: str) -> str:
    seen = set()
    output = []

    for line in text.splitlines():
        normalized = line.strip().lower()

        if not normalized:
            output.append(line)
            continue

        if normalized in seen:
            continue

        seen.add(normalized)
        output.append(line)

    return "\n".join(output).strip()


def compress_log_output(text: str, max_lines: int = 80) -> str:
    important_patterns = [
        "error",
        "exception",
        "failed",
        "failure",
        "warning",
        "traceback",
        "assert",
        "timeout",
        "denied",
        "unauthorized",
    ]

    lines = text.splitlines()
    important = [
        line for line in lines
        if any(pattern in line.lower() for pattern in important_patterns)
    ]

    if important:
        return "\n".join(important[:max_lines]).strip()

    return "\n".join(lines[-max_lines:]).strip()


def sanitize_context_text(text: str, source_type: str = "message") -> str:
    """
    Light sanitizer for low-value context.
    Do not use for system prompts, current user messages, code, SQL, JSON, YAML, or policies.
    """

    if not text:
        return text

    if source_type in {"system_prompt", "current_user_message", "code", "sql", "json", "yaml", "policy"}:
        return text

    if source_type in {"tool_log", "log"}:
        return compress_log_output(text)

    cleaned = remove_filler_phrases(text)
    cleaned = remove_duplicate_lines(cleaned)

    return cleaned