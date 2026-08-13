"""Stage 1 — get the page off the PDF, with its geometry intact.

`pdf_index/extract.py` next door reads a PDF as lines of text, which is all an
index needs. This stage keeps what that one throws away: the rectangle around
every line, the size and weight of every span, the images, the ruled grids.
Structure is recovered from those numbers, so they have to survive the read.

PyMuPDF is the base, as asked. The other two readers are kept as a degraded
path — no font sizes, no tables, no images, so headings fall back to the
textual rules — because a machine with only `pypdf` installed should still get
a usable document rather than a stack trace.

A page with no text layer is OCR'd, one page at a time. That granularity
matters: real documents are mixed, a scanned appendix bolted onto a typed
report, and OCR'ing the typed pages too would throw away good text and replace
it with a guess.
"""

from __future__ import annotations

import contextlib
import os
import re
import subprocess
import sys
import unicodedata
from typing import Callable, Iterator, List, Optional, Tuple

from .model import Line, PageContent, Span

# Soft hyphens, zero-width marks and the bidi controls a Hebrew PDF is full of.
# They carry no meaning and break every regex downstream.
_INVISIBLE = re.compile("[\u00ad\u200b-\u200f\u202a-\u202e\u2060\ufeff]")

# Hebrew and Arabic letters stored in their display shapes. Folding these back
# to ordinary letters is the one thing NFKC does that this pipeline needs.
_PRESENTATION_FORMS = re.compile("[\ufb1d-\ufb4f\ufb50-\ufdff\ufe70-\ufefc]")

# Where tesseract keeps its language data, when the environment has not said.
_TESSDATA_GUESSES = (
    "/usr/share/tesseract-ocr/5/tessdata",
    "/usr/share/tesseract-ocr/4.00/tessdata",
    "/usr/share/tessdata",
    "/usr/local/share/tessdata",
    "/opt/homebrew/share/tessdata",
)


class ReadError(RuntimeError):
    pass


def normalise(text: str) -> str:
    """Normalise one run of text and squeeze its whitespace.

    NFC, not NFKC. The compatibility forms are tempting — they fold ligatures
    and presentation forms into plain letters, which every later comparison
    benefits from — but they also flatten superscripts, and `c²` normalised to
    `c2` is a formula that now says something false. Ligatures are expanded by
    the reader instead, at extraction; the one compatibility fold worth having
    on its own — Hebrew and Arabic presentation forms, which some producers
    still emit — is applied to those characters alone.
    """
    return normalise_run(text).strip()


def normalise_run(text: str) -> str:
    """`normalise`, but keeping the spaces at the edges.

    Those edge spaces are load-bearing. A right-to-left line comes back as
    several runs whose boxes touch, so the only record that two words are
    separated is a space at the end of one run \u2014 strip it and the line
    reassembles as "\u05e4\u05e8\u05e7 1 \u2014\u05d7\u05d5\u05d6\u05d9\u05dd".
    """
    text = unicodedata.normalize("NFC", text or "")
    if _PRESENTATION_FORMS.search(text):
        text = _PRESENTATION_FORMS.sub(
            lambda match: unicodedata.normalize("NFKC", match.group()), text
        )
    text = _INVISIBLE.sub("", text)
    text = text.replace("\t", " ").replace("\u00a0", " ")
    return re.sub(r"[ ]{2,}", " ", text)


# ----------------------------------------------------------------- PyMuPDF ---


def _import_fitz():
    module = None
    try:
        import pymupdf  # PyMuPDF >= 1.24 ships under its own name

        module = pymupdf
    except ImportError:
        try:
            import fitz

            module = fitz
        except ImportError as exc:
            raise ReadError(
                "PyMuPDF is not installed. Install it with:\n"
                "  pip install -r tools/requirements.txt"
            ) from exc

    # PyMuPDF prints advice ("consider using pymupdf_layout") on stdout, which
    # is where this tool's Markdown goes when it is piped. Messages belong on
    # stderr with the rest of the progress reporting.
    try:
        module.set_messages(stream=sys.stderr)
    except (AttributeError, TypeError):
        pass
    return module


def _lines_from_dict(raw: dict, number: int) -> List[Line]:
    """Turn PyMuPDF's text dictionary into our lines, dropping empty ones."""
    lines: List[Line] = []
    for block in raw.get("blocks", []):
        if block.get("type") != 0:      # 1 is an image block; figures.py has it
            continue
        for line in block.get("lines", []):
            spans: List[Span] = []
            pieces: List[str] = []
            for span in line.get("spans", []):
                text = normalise_run(span.get("text", ""))
                if not text:
                    continue
                # A span of nothing but spaces is how some producers separate
                # two words. It carries no font of its own worth reading, but
                # dropping it would run the words together — here and again in
                # `objects.py`, which rebuilds table cells out of spans.
                pieces.append(text)
                spans.append(
                    Span(
                        text=text,
                        size=round(float(span.get("size", 0.0)), 2),
                        font=str(span.get("font", "")),
                        flags=int(span.get("flags", 0)),
                        bbox=tuple(span.get("bbox", (0, 0, 0, 0))),  # type: ignore[arg-type]
                    )
                )
            if not spans:
                continue

            raw = normalise_run("".join(pieces))
            text = raw.strip()
            if not text:
                continue

            # The size of the span that owns most of the characters — see the
            # note on Line.size about why not the maximum.
            weights: dict = {}
            bold_chars = 0
            for span in spans:
                weights[span.size] = weights.get(span.size, 0) + len(span.text)
                if span.bold:
                    bold_chars += len(span.text)
            size = max(weights.items(), key=lambda kv: kv[1])[0]

            lines.append(
                Line(
                    text=text,
                    page=number,
                    bbox=tuple(line.get("bbox", (0, 0, 0, 0))),  # type: ignore[arg-type]
                    size=size,
                    bold=bold_chars * 2 > len(text),
                    spans=spans,
                    pad_left=raw[:1] == " ",
                    pad_right=raw[-1:] == " ",
                )
            )
    return lines


def _page_has_text(lines: List[Line], min_chars: int) -> bool:
    return sum(len(line.text) for line in lines) >= min_chars


# --------------------------------------------------------------------- OCR ---


def tessdata_dir() -> Optional[str]:
    """Where tesseract's language files are, or None if they cannot be found."""
    env = os.environ.get("TESSDATA_PREFIX")
    if env and os.path.isdir(env):
        return env
    for path in _TESSDATA_GUESSES:
        if os.path.isdir(path):
            return path
    return None


def ocr_languages() -> List[str]:
    """The language packs installed, asked of tesseract itself."""
    try:
        out = subprocess.run(
            ["tesseract", "--list-langs"],
            capture_output=True, text=True, timeout=20, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return [
        line.strip()
        for line in out.stdout.splitlines()[1:]
        if line.strip() and " " not in line.strip()
    ]


def ocr_available() -> bool:
    return bool(ocr_languages())


def resolve_ocr_language(requested: str) -> Tuple[str, List[str]]:
    """Keep only the requested packs that exist, and say what was missing.

    Asking tesseract for `heb+eng` when Hebrew is not installed fails the whole
    call, so a document that is 90% English would lose its OCR entirely over a
    language it barely uses. Dropping the missing pack and warning is the more
    useful failure.
    """
    installed = set(ocr_languages())
    if not installed:
        return requested, []
    wanted = [part for part in requested.split("+") if part]
    keep = [part for part in wanted if part in installed]
    missing = [part for part in wanted if part not in installed]
    if not keep:
        keep = ["eng"] if "eng" in installed else [sorted(installed)[0]]
    return "+".join(keep), missing


def _ocr_page(page, number: int, language: str, dpi: int) -> List[Line]:
    """Run OCR over one page and return its lines, with real boxes.

    PyMuPDF's own OCR path is preferred because it returns a text page in the
    same shape as a read one — same dictionary, same bboxes, same code after
    this point. pytesseract is the fallback for builds without OCR support
    compiled in; it gives word boxes, which are stitched into lines here.
    """
    try:
        textpage = page.get_textpage_ocr(
            flags=0, language=language, dpi=dpi, full=True
        )
        return _lines_from_dict(page.get_text("dict", textpage=textpage), number)
    except (RuntimeError, ValueError, TypeError):
        pass
    return _ocr_page_pytesseract(page, number, language, dpi)


def _ocr_page_pytesseract(page, number: int, language: str, dpi: int) -> List[Line]:
    import io

    try:
        import pytesseract
        from PIL import Image
    except ImportError as exc:
        raise ReadError(
            "This page has no text layer and OCR is unavailable.\n"
            "  Install tesseract (apt install tesseract-ocr tesseract-ocr-heb)\n"
            "  and pytesseract, or pass --ocr never to skip scanned pages."
        ) from exc

    zoom = dpi / 72.0
    pixmap = page.get_pixmap(dpi=dpi)
    image = Image.open(io.BytesIO(pixmap.tobytes("png")))
    data = pytesseract.image_to_data(
        image, lang=language, output_type=pytesseract.Output.DICT
    )

    # Words arrive one per row, already grouped by block/paragraph/line; the
    # grouping keys are what put them back together in reading order.
    grouped: dict = {}
    for i, word in enumerate(data["text"]):
        word = normalise(word)
        if not word or int(data["conf"][i]) < 0:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        left, top = data["left"][i] / zoom, data["top"][i] / zoom
        right = (data["left"][i] + data["width"][i]) / zoom
        bottom = (data["top"][i] + data["height"][i]) / zoom
        entry = grouped.setdefault(key, {"words": [], "bbox": [left, top, right, bottom]})
        entry["words"].append(word)
        box = entry["bbox"]
        box[0], box[1] = min(box[0], left), min(box[1], top)
        box[2], box[3] = max(box[2], right), max(box[3], bottom)

    lines: List[Line] = []
    for key in sorted(grouped):
        entry = grouped[key]
        text = normalise(" ".join(entry["words"]))
        if not text:
            continue
        box = entry["bbox"]
        # OCR reports no font size; the glyph height stands in for one, which
        # is enough for the "is this bigger than the body text" question.
        size = round(box[3] - box[1], 2)
        lines.append(
            Line(text=text, page=number, bbox=tuple(box), size=size, bold=False)
        )
    return lines


# ------------------------------------------------------------------- read ---


@contextlib.contextmanager
def open_pdf(path: str) -> Iterator:
    """Open the document once, for every stage that needs the file itself.

    Reading, table finding, image extraction and OCR all want the same handle.
    Opening it per stage would parse a 300-page file four times, and holding a
    page object past the close is a segfault rather than an exception — so the
    lifetime is made explicit here and the stages run inside it.
    """
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    fitz = _import_fitz()
    doc = fitz.open(path)
    try:
        yield doc
    finally:
        doc.close()


def read_pages(
    doc,
    ocr: str = "auto",
    ocr_language: str = "heb+eng",
    ocr_dpi: int = 300,
    first_page: int = 1,
    last_page: Optional[int] = None,
    min_chars_per_page: int = 40,
    on_progress: Optional[Callable[[int, int, str], None]] = None,
) -> Tuple[List[PageContent], dict]:
    """Read an open document into pages, OCR'ing the ones that need it.

    `ocr` is auto (OCR a page only when it has no text worth the name), never,
    or always. Returns the pages and a dictionary of facts about the read —
    which backend ran, which pages were OCR'd, what was asked for and missing —
    which the manifest publishes so a bad result can be traced to its cause.
    """
    info = {
        "backend": "pymupdf",
        "ocr": {"mode": ocr, "pages": [], "language": "", "missing_languages": []},
        "pdf": {},
    }

    language = ocr_language
    if ocr != "never":
        language, missing = resolve_ocr_language(ocr_language)
        info["ocr"]["language"] = language
        info["ocr"]["missing_languages"] = missing
        prefix = tessdata_dir()
        if prefix and not os.environ.get("TESSDATA_PREFIX"):
            # PyMuPDF's OCR reads this variable and nothing else.
            os.environ["TESSDATA_PREFIX"] = prefix

    fitz = _import_fitz()
    # Ligatures expanded at the source: "ﬁ" is one character in the file and
    # two letters in the word, and every search for "definition" wants the two.
    flags = fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_LIGATURES

    pages: List[PageContent] = []
    meta = doc.metadata or {}
    info["pdf"] = {
        "title": normalise(meta.get("title", "")),
        "author": normalise(meta.get("author", "")),
        "producer": normalise(meta.get("producer", "")),
        "created": meta.get("creationDate", ""),
        "encrypted": bool(doc.is_encrypted),
        "page_count": doc.page_count,
    }
    info["toc"] = [
        [int(level), normalise(title), int(page)]
        for level, title, page in (doc.get_toc() or [])
        if normalise(title)
    ]

    end = doc.page_count if last_page is None else min(last_page, doc.page_count)
    for index in range(max(first_page - 1, 0), end):
        page = doc[index]
        number = index + 1
        if on_progress:
            on_progress(number, end, "read")

        lines = _lines_from_dict(page.get_text("dict", flags=flags), number)
        source = "text"

        needs_ocr = ocr == "always" or (
            ocr == "auto" and not _page_has_text(lines, min_chars_per_page)
        )
        if needs_ocr and ocr != "never":
            if on_progress:
                on_progress(number, end, "ocr")
            ocr_lines = _ocr_page(page, number, language, ocr_dpi)
            # A page can genuinely be near-empty — a part title, a blank
            # verso. Only prefer the OCR when it actually found more.
            if sum(len(l.text) for l in ocr_lines) > sum(len(l.text) for l in lines):
                lines, source = ocr_lines, "ocr"
                info["ocr"]["pages"].append(number)

        rect = page.rect
        content = PageContent(
            number=number,
            width=float(rect.width),
            height=float(rect.height),
            lines=lines,
            source=source,
        )
        _attach_raw_page(content, page)
        pages.append(content)

    if not pages:
        raise ReadError("The file has no pages.")
    return pages, info


# The page object is needed again by tables.py and figures.py, which run after
# the document is closed in the caller's mind but before it is in fact. Rather
# than reopen the file per stage, the reader hands the live page over on the
# content object and the object stages take it from there.
def _attach_raw_page(content: PageContent, page) -> None:
    setattr(content, "_raw_page", page)


def raw_page(content: PageContent):
    return getattr(content, "_raw_page", None)


def detach_raw_pages(pages: List[PageContent]) -> None:
    """Drop the PyMuPDF handles once the objects have been harvested.

    They point into a document that is about to close; anything holding one
    after that gets a segfault rather than an exception.
    """
    for page in pages:
        if hasattr(page, "_raw_page"):
            delattr(page, "_raw_page")


# --------------------------------------------------- degraded text-only path ---


def read_pages_without_geometry(
    path: str, first_page: int = 1, last_page: Optional[int] = None
) -> Tuple[List[PageContent], dict]:
    """Read with whatever `pdf_index` can import, when PyMuPDF is absent.

    Every line comes back at the same size with a made-up box, so heading
    detection has only its textual rules and there are no tables or figures.
    Stated plainly in the manifest rather than papered over.
    """
    from ..pdf_index.extract import extract_pages

    plain = extract_pages(path, first_page=first_page, last_page=last_page)
    pages: List[PageContent] = []
    for page in plain:
        lines = [
            Line(
                text=text,
                page=page.number,
                # A synthetic box that keeps lines in order and nothing else.
                bbox=(0.0, float(i * 12), float(len(text) * 6), float(i * 12 + 10)),
                size=10.0,
                bold=False,
            )
            for i, text in enumerate(page.lines)
        ]
        pages.append(
            PageContent(number=page.number, width=595.0, height=842.0, lines=lines)
        )
    return pages, {
        "backend": "pdf_index-fallback",
        "ocr": {"mode": "never", "pages": [], "language": "", "missing_languages": []},
        "pdf": {"page_count": len(pages)},
        "toc": [],
        "degraded": True,
    }
