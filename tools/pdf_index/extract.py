"""Stage 1 — get text off the page.

Three readers are supported and tried in order of how well they preserve
layout: PyMuPDF, pdfplumber, pypdf. Whichever is installed wins; the rest of
the pipeline never learns which one ran, because everything downstream takes
a list of `Page` objects and nothing else.

A PDF with no text layer (a scan) produces empty pages here. That is not an
error this module can fix — it needs OCR — but it is reported clearly rather
than silently handing the next stage 300 blank pages.
"""

from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Page:
    """One page of the document, kept as lines because headings are lines.

    `number` is the 1-based page number as a reader would count it, which is
    what the index has to quote. `lines` is what survives cleaning; `dropped`
    keeps the running headers and footers that were removed, so a mis-tuned
    cleaner can be debugged instead of guessed at.
    """

    number: int
    lines: List[str]
    dropped: List[str] = field(default_factory=list)
    is_toc: bool = False

    @property
    def text(self) -> str:
        return "\n".join(self.lines)

    @property
    def char_count(self) -> int:
        return sum(len(line) for line in self.lines)


class ExtractionError(RuntimeError):
    pass


# Characters that carry no meaning but break every regex and every match:
# soft hyphens, zero-width joiners, and the bidi marks a Hebrew PDF is full of.
_INVISIBLE = re.compile("[\u00ad\u200b-\u200f\u202a-\u202e\u2060\ufeff]")


def _normalise(raw: str) -> List[str]:
    """Unicode-normalise a page and split it into non-empty lines."""
    text = unicodedata.normalize("NFKC", raw or "")
    text = _INVISIBLE.sub("", text)
    text = text.replace("\t", " ").replace("\u00a0", " ")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = []
    for line in text.split("\n"):
        line = re.sub(r" {2,}", " ", line).strip()
        if line:
            lines.append(line)
    return lines


def _read_pymupdf(path: str) -> List[List[str]]:
    import fitz  # PyMuPDF

    with fitz.open(path) as doc:
        return [_normalise(page.get_text("text")) for page in doc]


def _read_pdfplumber(path: str) -> List[List[str]]:
    import pdfplumber

    with pdfplumber.open(path) as doc:
        return [_normalise(page.extract_text() or "") for page in doc.pages]


def _read_pypdf(path: str) -> List[List[str]]:
    from pypdf import PdfReader

    reader = PdfReader(path)
    return [_normalise(page.extract_text() or "") for page in reader.pages]


_BACKENDS: List[tuple] = [
    ("pymupdf", _read_pymupdf),
    ("pdfplumber", _read_pdfplumber),
    ("pypdf", _read_pypdf),
]


def available_backends() -> List[str]:
    """Which PDF readers this interpreter can actually use.

    The import is really attempted rather than looked up: a reader can be
    installed and still be unusable because a native dependency of its own is
    broken, and "installed" would be a misleading answer to give.
    """
    import importlib

    names = {"pymupdf": "fitz", "pdfplumber": "pdfplumber", "pypdf": "pypdf"}
    usable = []
    for name, _ in _BACKENDS:
        try:
            importlib.import_module(names[name])
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException:
            continue
        usable.append(name)
    return usable


def extract_pages(
    path: str,
    backend: Optional[str] = None,
    first_page: int = 1,
    last_page: Optional[int] = None,
) -> List[Page]:
    """Read `path` into pages. `first_page`/`last_page` are 1-based, inclusive.

    Page numbers are preserved across a range selection: asking for pages
    25-67 gives you pages numbered 25-67, not 1-43, because the whole point
    of the index is that its numbers match the printed book.
    """
    # Checked here so a missing file is reported as a missing file, rather
    # than as three readers that each mysteriously failed.
    if not os.path.exists(path):
        raise FileNotFoundError(path)

    readers: List[tuple] = _BACKENDS
    if backend:
        readers = [(n, f) for n, f in _BACKENDS if n == backend]
        if not readers:
            raise ExtractionError(f"Unknown backend {backend!r}")

    errors = []
    raw_pages: Optional[List[List[str]]] = None
    for name, reader in readers:
        try:
            raw_pages = reader(path)
            break
        except ImportError:
            errors.append(f"{name}: not installed")
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:
            # Not just Exception: a reader with a broken native dependency can
            # raise a panic that inherits from BaseException, and one broken
            # install should cost us that reader, not the whole run.
            errors.append(f"{name}: {exc}")

    if raw_pages is None:
        raise ExtractionError(
            "No PDF reader could read the file.\n  "
            + "\n  ".join(errors)
            + "\nInstall one with: pip install -r tools/requirements.txt"
        )

    end = len(raw_pages) if last_page is None else min(last_page, len(raw_pages))
    pages = [
        Page(number=i + 1, lines=raw_pages[i])
        for i in range(max(first_page - 1, 0), end)
    ]

    if pages and not any(page.lines for page in pages):
        raise ExtractionError(
            "The file has no text layer — it is probably a scan. "
            "Run OCR first (ocrmypdf in.pdf out.pdf), then try again."
        )
    return pages


def pages_from_text(chunks: List[str], first_number: int = 1) -> List[Page]:
    """Build pages from strings — the stages after this one need nothing else."""
    return [
        Page(number=first_number + i, lines=_normalise(chunk))
        for i, chunk in enumerate(chunks)
    ]
