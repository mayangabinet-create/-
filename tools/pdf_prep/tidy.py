"""Stage 4 — remove what is on the page but not in the document.

A 300-page book carries 300 copies of its running header and 300 page
numbers. To a reader they are furniture and invisible. To a model they are the
most repeated text in the document: they dilute every retrieval, and when the
header happens to be the book's title they look like the answer to every
question.

Nothing is deleted silently. Every line removed is kept on `page.dropped`, and
the manifest reports the counts, so a cleaner that ate a real paragraph can be
caught rather than guessed at.

The one repair that has to happen before anything else is reading direction:
some readers hand back Hebrew in the order it was painted, left to right, and
until that is flipped there is no text here for any other rule to match.
"""

from __future__ import annotations

import re
from typing import Dict, List

from ..pdf_index.clean import (
    flip_line,
    looks_like_contents,
    looks_like_page_number,
)
from .model import Line, PageContent, script_ratio

_DIGITS = re.compile(r"\d+")

# A line of pure decoration: a rule, a row of dots, a divider.
_DECORATION = re.compile(r"^[\s._\-–—=*·•~^─-╿]{3,}$")

# Latin words split across a line break: "consid-\neration". Hebrew does not
# hyphenate this way, so the rule is deliberately Latin-only.
_HYPHEN_BREAK = re.compile(r"([A-Za-zÀ-ɏ]{2,})-$")

_HEBREW_MARKERS = (
    "של", "את", "על", "לא", "זה", "הוא", "היא", "אשר", "כי", "עם", "אין",
    "יש", "כל", "גם", "או", "אם", "בין", "לפי", "אל", "כדי", "לאחר", "בית",
)


def _marker_hits(text: str) -> int:
    words = set(re.findall(r"[֐-׿]+", text))
    return sum(1 for marker in _HEBREW_MARKERS if marker in words)


def repair_direction(pages: List[PageContent]) -> bool:
    """Flip every line if the reader returned right-to-left text reversed.

    The test is a vote: count common Hebrew function words in the text as it
    stands and in the text reversed, and believe whichever direction wins. A
    document with no Hebrew scores zero both ways and is left alone.
    """
    sample = "\n".join(page.text for page in pages[:30])[:20000]
    if not sample:
        return False
    rtl, _ = script_ratio(sample)
    if rtl < 40:
        return False
    if _marker_hits(sample[::-1]) <= _marker_hits(sample):
        return False

    for page in pages:
        for line in page.lines:
            line.text = flip_line(line.text)
            for span in line.spans:
                span.text = flip_line(span.text)
    return True


def _fingerprint(text: str) -> str:
    """A line with its numbers blanked, so page 41 and page 42 look alike."""
    return _DIGITS.sub("#", text.strip().lower())


def _edge_lines(page: PageContent, band: float) -> List[Line]:
    """The lines that sit in the margins, judged by where they are on the page.

    By position only. Counting the first and last lines of the page as edge
    lines as well is tempting, and wrong: on a sparse page the body text is
    the first line, and since repetition is measured with the digits blanked,
    "Body text on page 3" and "Body text on page 4" are the same fingerprint.
    Two pages of that and the cleaner deletes the document.
    """
    if not page.lines:
        return []
    top = page.height * band
    bottom = page.height * (1 - band)
    return [
        line for line in page.lines if line.bottom <= top or line.top >= bottom
    ]


def drop_running_furniture(
    pages: List[PageContent],
    threshold: float = 0.35,
    band: float = 0.12,
) -> Dict[str, int]:
    """Remove running headers and footers, page numbers and blank decoration.

    A header is recognised by repetition in the margins, not by its wording:
    the same string at the top of a third of the pages is furniture whatever
    it says. Repetition is counted on a fingerprint with the digits blanked,
    so "פרק 2 | עמוד 41" and "פרק 2 | עמוד 42" are seen to be the same line.
    """
    stats = {"headers": 0, "page_numbers": 0, "decoration": 0, "contents_pages": 0}

    counts: Dict[str, int] = {}
    # Three pages is the fewest that can show a line repeating rather than
    # merely appearing twice.
    if len(pages) >= 3:
        for page in pages:
            seen = set()
            for line in _edge_lines(page, band):
                fingerprint = _fingerprint(line.text)
                # Long lines at a page edge are body text that happened to land
                # there — a paragraph starting at the top of the page.
                if 4 <= len(fingerprint) <= 90:
                    seen.add(fingerprint)
            for fingerprint in seen:
                counts[fingerprint] = counts.get(fingerprint, 0) + 1

    floor = max(3, int(len(pages) * threshold))
    furniture = {f for f, n in counts.items() if n >= floor}

    for page in pages:
        if looks_like_contents([line.text for line in page.lines]):
            page.is_toc = True
            page.dropped.extend(line.text for line in page.lines)
            stats["contents_pages"] += 1
            # Emptied, not removed: page 5 stays page 5, with a hole in it, so
            # every page number quoted downstream is still the printed one.
            page.lines = []
            continue

        edges = {id(line) for line in _edge_lines(page, band)}
        kept: List[Line] = []
        for line in page.lines:
            text = line.text.strip()
            if id(line) in edges and _fingerprint(text) in furniture:
                page.dropped.append(text)
                stats["headers"] += 1
                continue
            if looks_like_page_number(text):
                page.dropped.append(text)
                stats["page_numbers"] += 1
                continue
            if _DECORATION.match(text):
                page.dropped.append(text)
                stats["decoration"] += 1
                continue
            kept.append(line)
        page.lines = kept

    return stats


def join_hyphenated(pages: List[PageContent]) -> int:
    """Re-join Latin words broken across a line break, within a page.

    Only within a page: a word broken across a *page* break is rejoined later,
    when paragraphs are assembled and the page marker between them can be
    placed correctly.
    """
    joined = 0
    for page in pages:
        out: List[Line] = []
        for line in page.lines:
            if out:
                match = _HYPHEN_BREAK.search(out[-1].text)
                if match and line.text[:1].isalpha() and line.text[:1].islower():
                    head = out[-1].text[: match.start(1)]
                    word, _, rest = line.text.partition(" ")
                    out[-1].text = head + match.group(1) + word
                    joined += 1
                    if not rest:
                        continue
                    line.text = rest
            out.append(line)
        page.lines = out
    return joined


def tidy_pages(
    pages: List[PageContent],
    fix_direction: bool = True,
    header_threshold: float = 0.35,
) -> Dict[str, object]:
    """Run the whole cleaning stage and report what it took."""
    flipped = repair_direction(pages) if fix_direction else False
    stats = drop_running_furniture(pages, threshold=header_threshold)
    stats_out: Dict[str, object] = dict(stats)
    stats_out["hyphens_joined"] = join_hyphenated(pages)
    stats_out["direction_repaired"] = flipped
    return stats_out
