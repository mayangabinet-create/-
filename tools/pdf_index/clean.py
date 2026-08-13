"""Stage 2 — drop everything that is on the page but not in the book.

A 300-page PDF carries roughly 300 copies of the running header, 300 page
numbers, and a table of contents whose dot leaders look like sentences to a
tokeniser. Left in, that boilerplate is the single most repeated text in the
document, so TF-IDF treats it as background noise at best and, when the
header happens to be the book's title, as the answer to every query.

Nothing here is deleted destructively: whatever a page loses is kept on
`page.dropped`, so `--show-dropped` can prove the cleaner took the right
lines.
"""

from __future__ import annotations

import re
from typing import Dict, List

from .extract import Page

# A line that is only a page number, in Arabic digits, Roman numerals or
# Hebrew letters — with or without decoration like "- 42 -" or "עמ' 42".
_PAGE_NUMBER = re.compile(
    r"""^(?:
        [-–—\[\(\s]*\d{1,4}[-–—\]\)\s]*
      | (?=[ivxlcdm])m{0,3}(?:c[md]|d?c{0,3})(?:x[cl]|l?x{0,3})(?:i[xv]|v?i{0,3})
      | (?:עמ['׳]?|עמוד|page|p\.)\s*\d{1,4}
      | \d{1,4}\s*(?:/|מתוך|of)\s*\d{1,4}
    )$""",
    re.VERBOSE | re.IGNORECASE,
)

# "1.4 Something something ......... 27" — a table-of-contents row. Extraction
# collapses the runs of spaces some contents pages align with, so a row with no
# dot leaders is recognised by its shape instead: a heading word, then a number.
_TOC_ROW = re.compile(
    # Dot leaders, with or without the page number after them: readers often
    # return the number as a separate run, so the row can end at the dots.
    r"[.·․…]\s?[.·․…]\s?[.·․…]\s?[.·․…]"
    r"|^(?:פרק|שער|חלק|נספח|סעיף|יחידה|chapter|part|section|appendix|unit)\b"
    r".{0,80}?\s\d{1,4}\s*$",
    re.IGNORECASE,
)

_DIGITS = re.compile(r"\d+")

# Common Hebrew words, used only to tell which direction a line runs in.
# They are function words, so any real page of Hebrew contains several.
_HEBREW_MARKERS = (
    "של", "את", "על", "לא", "זה", "הוא", "היא", "אשר", "כי", "עם", "אין",
    "יש", "כל", "גם", "או", "אם", "בין", "לפי", "אל", "כדי", "לאחר", "בית",
)

# A run of Latin letters or digits inside a reversed line has to be flipped
# back, or 2024 comes out as 4202.
_LTR_RUN = re.compile(r"[0-9A-Za-z][0-9A-Za-z.,:/\\-]*")

# Latin words split across a line break: "consid-\neration".
_HYPHEN_BREAK = re.compile(r"([A-Za-zÀ-ɏ]{2,})-$")


def _marker_hits(text: str) -> int:
    """How many common Hebrew words appear in `text`, as whole words."""
    words = set(re.findall(r"[\u0590-\u05ff]+", text))
    return sum(1 for marker in _HEBREW_MARKERS if marker in words)


def flip_line(line: str) -> str:
    """Reverse a line's characters, keeping numbers and Latin runs readable."""
    return _LTR_RUN.sub(lambda m: m.group()[::-1], line[::-1])


def looks_visually_ordered(pages: List[Page]) -> bool:
    """Did the reader hand back RTL text in the order it was painted?

    Some readers walk a Hebrew page left to right and return each line
    reversed — "פרק 1 — חוזים" arrives as "םיזוח — 1 קרפ". Every heuristic
    after this point then looks for a keyword that is no longer there, and
    the whole index comes out as noise.

    The test is a vote: count common Hebrew words in the text as it stands
    and in the text reversed, and believe whichever direction wins. On a
    document with no Hebrew in it, both counts are zero and nothing happens.
    """
    sample = "\n".join(page.text for page in pages[:30])[:20000]
    if not sample:
        return False
    forward = _marker_hits(sample)
    backward = _marker_hits(sample[::-1])
    return backward > forward


def repair_visual_order(pages: List[Page]) -> bool:
    """Flip every line if the document came back visually ordered. Returns whether it did."""
    if not looks_visually_ordered(pages):
        return False
    for page in pages:
        page.lines = [flip_line(line) for line in page.lines]
    return True


def looks_like_page_number(line: str) -> bool:
    """Is this line nothing but a page number? "42", "- 42 -", "עמ' 42", "xiv"."""
    return bool(_PAGE_NUMBER.match(line.strip()))


def looks_like_contents(lines: List[str]) -> bool:
    """Is this page a table of contents rather than prose?

    Judged by how many of its lines end in a dot leader and a number. Three
    such rows happen in an index or a price list too, so the test is a share
    of the page, not a raw count.
    """
    if len(lines) < 4:
        return False
    rows = sum(1 for line in lines if _TOC_ROW.search(line))
    return rows >= 3 and rows >= len(lines) * 0.4


def _fingerprint(line: str) -> str:
    """A line with its numbers blanked, so page 41 and page 42 look alike."""
    return _DIGITS.sub("#", line.strip().lower())


def _repeated_edge_lines(
    pages: List[Page], edge: int = 3, threshold: float = 0.35
) -> set:
    """Fingerprints that appear at the top or bottom of enough pages to be furniture.

    Only the first and last few lines of each page are candidates. A sentence
    repeated mid-page is a quotation or a refrain; the same string sitting at
    the top of 120 pages is a running header.
    """
    if len(pages) < 4:
        return set()

    counts: Dict[str, int] = {}
    for page in pages:
        seen = set()
        for line in page.lines[:edge] + page.lines[-edge:]:
            fp = _fingerprint(line)
            # Long lines are body text that happened to land at a page edge.
            if len(fp) < 4 or len(fp) > 90:
                continue
            seen.add(fp)
        for fp in seen:
            counts[fp] = counts.get(fp, 0) + 1

    floor = max(3, int(len(pages) * threshold))
    return {fp for fp, n in counts.items() if n >= floor}


def _looks_like_toc(page: Page) -> bool:
    return looks_like_contents(page.lines)


def _join_hyphenated(lines: List[str]) -> List[str]:
    """Re-join Latin words broken across lines. Hebrew does not hyphenate this way."""
    out: List[str] = []
    for line in lines:
        if out:
            match = _HYPHEN_BREAK.search(out[-1])
            if match and line[:1].isalpha() and line[:1].islower():
                head = out[-1][: match.start(1)]
                word, _, rest = line.partition(" ")
                out[-1] = head + match.group(1) + word
                if rest:
                    out.append(rest)
                continue
        out.append(line)
    return out


def clean_pages(
    pages: List[Page],
    drop_toc: bool = True,
    header_threshold: float = 0.35,
    fix_rtl: bool = True,
) -> List[Page]:
    """Remove boilerplate from every page, in place, and return the same list.

    Reading direction is repaired first: every later step matches text
    against keywords, and on a visually ordered page there is no text to
    match. Table-of-contents pages are flagged and emptied rather than
    removed, so page numbering stays honest — page 5 is still page 5 with a
    hole in it.
    """
    if fix_rtl:
        repair_visual_order(pages)

    boilerplate = _repeated_edge_lines(pages, threshold=header_threshold)

    for page in pages:
        if _looks_like_toc(page):
            page.is_toc = True
            if drop_toc:
                page.dropped.extend(page.lines)
                page.lines = []
                continue

        kept: List[str] = []
        for i, line in enumerate(page.lines):
            at_edge = i < 3 or i >= len(page.lines) - 3
            if at_edge and _fingerprint(line) in boilerplate:
                page.dropped.append(line)
                continue
            if _PAGE_NUMBER.match(line):
                page.dropped.append(line)
                continue
            kept.append(line)

        page.lines = _join_hyphenated(kept)

    return pages


def page_text(pages: List[Page]) -> str:
    """The whole cleaned document as one string, pages separated by a blank line."""
    return "\n\n".join(page.text for page in pages if page.lines)
