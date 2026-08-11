"""Stage 3 — find the chapters.

Font sizes would make this easy, but only one of the three readers exposes
them, so detection is textual and works the same whichever reader ran. Three
signals, in falling order of trust:

1. A keyword and a numeral — "פרק 2", "פרק ב'", "Chapter Two", "נספח א".
2. A decimal outline — "1.", "2.4", "3.1.7 Something".
3. Short standalone title lines, used only when the first two found almost
   nothing, because on a book with real chapter headings this signal fires on
   every line of every address, table cell and figure caption.

Each heading remembers where it was found, down to the line, so a chapter's
text can be sliced without dragging in the previous chapter's last paragraph.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional

from .extract import Page

HEBREW = re.compile("[\u0590-\u05ff]")
LATIN = re.compile(r"[A-Za-z]")

# Level 1 is the coarsest division. A "chapter" inside a "part" has to sort
# below it or the index nests wrongly.
_KEYWORD_LEVELS = {
    "חלק": 1,
    "שער": 1,
    "book": 1,
    "part": 1,
    "פרק": 2,
    "chapter": 2,
    "יחידה": 2,
    "unit": 2,
    "נספח": 2,
    "appendix": 2,
    "סעיף": 3,
    "section": 3,
    "תת-פרק": 3,
}

_KEYWORDS = sorted(_KEYWORD_LEVELS, key=len, reverse=True)

_HEBREW_ORDINALS = {
    "ראשון": 1, "ראשונה": 1, "שני": 2, "שנייה": 2, "שניה": 2,
    "שלישי": 3, "שלישית": 3, "רביעי": 4, "רביעית": 4,
    "חמישי": 5, "חמישית": 5, "שישי": 6, "ששי": 6, "שישית": 6,
    "שביעי": 7, "שביעית": 7, "שמיני": 8, "שמינית": 8,
    "תשיעי": 9, "תשיעית": 9, "עשירי": 10, "עשירית": 10,
}

_ENGLISH_ORDINALS = {
    "one": 1, "first": 1, "two": 2, "second": 2, "three": 3, "third": 3,
    "four": 4, "fourth": 4, "five": 5, "fifth": 5, "six": 6, "sixth": 6,
    "seven": 7, "seventh": 7, "eight": 8, "eighth": 8, "nine": 9, "ninth": 9,
    "ten": 10, "tenth": 10, "eleven": 11, "twelve": 12,
}

_GEMATRIA = {
    "א": 1, "ב": 2, "ג": 3, "ד": 4, "ה": 5, "ו": 6, "ז": 7, "ח": 8, "ט": 9,
    "י": 10, "כ": 20, "ך": 20, "ל": 30, "מ": 40, "ם": 40, "נ": 50, "ן": 50,
    "ס": 60, "ע": 70, "פ": 80, "ף": 80, "צ": 90, "ץ": 90,
    "ק": 100, "ר": 200, "ש": 300, "ת": 400,
}

_ROMAN = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}

# The punctuation a heading uses to separate its number from its title.
_SEPARATOR = r"[\s:\-–—.,)\]]*"

_KEYWORD_HEADING = re.compile(
    r"^(?P<kw>" + "|".join(re.escape(k) for k in _KEYWORDS) + r")"
    r"\s+(?P<num>\S+)"
    r"(?P<sep>" + _SEPARATOR + r")(?P<title>.*)$",
    re.IGNORECASE,
)

_OUTLINE_HEADING = re.compile(
    r"^(?P<num>\d{1,2}(?:\.\d{1,2}){0,3})[.)]?\s+(?P<title>\S.{0,90})$"
)

_SENTENCE_END = re.compile(r"[.!?:;,]$")

# Words that follow the keyword in a sentence rather than in a heading.
_NOT_A_NUMBER = {
    "of", "in", "the", "and", "is", "was", "this", "that", "which",
    "זה", "זו", "הזה", "של", "את", "אשר", "הוא", "היא", "כי", "על", "עם",
}


@dataclass
class Heading:
    """A heading, and exactly where it sits in the page/line grid."""

    title: str
    level: int
    page: int
    page_index: int   # index into the pages list, not the printed number
    line_index: int
    number: Optional[int] = None
    keyword: str = ""
    kind: str = "keyword"   # keyword | outline | title
    numbering: str = ""     # as printed: "2.1" keeps its depth, unlike number

    @property
    def label(self) -> str:
        """"פרק 2 — מיסוי", rebuilt in a consistent shape."""
        parts = []
        if self.keyword:
            parts.append(self.keyword if self.number is None
                         else f"{self.keyword} {self.number}")
        elif self.kind == "outline":
            parts.append(self.numbering or str(self.number))
        head = " ".join(parts)
        if head and self.title:
            return f"{head} — {self.title}"
        return head or self.title


def detect_language(pages: List[Page]) -> str:
    """'he' or 'en', decided by which script most of the letters are in.

    Only used to pick the labels the index prints; every other stage treats
    the scripts identically.
    """
    sample = " ".join(page.text for page in pages[:40])[:20000]
    hebrew = len(HEBREW.findall(sample))
    latin = len(LATIN.findall(sample))
    return "he" if hebrew > latin else "en"


def _gematria(token: str) -> Optional[int]:
    """Hebrew letters as a number: ב -> 2, כ״ה -> 25. Rejects ordinary words.

    Every Hebrew word of three letters or fewer is also a valid gematria
    number — דין would come out as 74 — so a multi-letter token only counts
    when it carries the geresh or gershayim that marks it as a numeral.
    """
    marked = bool(re.search(r"['\"׳״]", token))
    letters = re.sub(r"['\"׳״]", "", token)
    if not letters or len(letters) > 3:
        return None
    if len(letters) > 1 and not marked:
        return None
    total = 0
    for ch in letters:
        if ch not in _GEMATRIA:
            return None
        total += _GEMATRIA[ch]
    return total or None


def _roman(token: str) -> Optional[int]:
    token = token.lower()
    if not token or any(ch not in _ROMAN for ch in token):
        return None
    total, prev = 0, 0
    for ch in reversed(token):
        value = _ROMAN[ch]
        total += -value if value < prev else value
        prev = max(prev, value)
    return total or None


def parse_numeral(token: str, hebrew_context: bool) -> Optional[int]:
    """Turn '2', 'ב׳', 'II' or 'second' into 2. None if it is not a numeral."""
    token = token.strip()
    if not token:
        return None
    if token.isdigit():
        return int(token)

    word = token.lower().strip("'\"׳״.,:")
    if word in _ENGLISH_ORDINALS:
        return _ENGLISH_ORDINALS[word]
    if word in _HEBREW_ORDINALS:
        return _HEBREW_ORDINALS[word]

    # Roman first for Latin script; a bare "I" is a numeral, not a word.
    if re.fullmatch(r"[IVXLCDM]{1,6}", token):
        return _roman(token)
    if hebrew_context and re.fullmatch(r"[\u05d0-\u05ea]['\"\u05f3\u05f4\u05d0-\u05ea]{0,3}", token):
        return _gematria(token)
    return None


def _match_keyword_heading(line: str, hebrew_context: bool) -> Optional[Heading]:
    match = _KEYWORD_HEADING.match(line)
    if not match:
        return None

    keyword = match.group("kw")
    level = _KEYWORD_LEVELS[keyword.lower()]
    number = parse_numeral(match.group("num"), hebrew_context)
    title = match.group("title").strip(" -–—:.\t")

    if number is None:
        # "פרק המבוא" — a keyword with a word after it, not a number. Accept it
        # only if the line is short enough to be a heading rather than a
        # sentence that happens to open with the word "chapter", and only if
        # the word after the keyword is not the grammar of a sentence
        # ("Part of the estate...", "פרק זה עוסק...").
        word = match.group("num").strip(" -–—:.,;'\"׳״")
        if len(line) > 60 or word.lower() in _NOT_A_NUMBER:
            return None
        if LATIN.match(word) and not word[:1].isupper():
            return None
        title = (word + " " + title).strip()

    if _SENTENCE_END.search(line) and len(line) > 60:
        return None

    return Heading(
        title=title,
        level=level,
        page=0,
        page_index=0,
        line_index=0,
        number=number,
        keyword=keyword,
    )


def _match_outline_heading(line: str) -> Optional[Heading]:
    match = _OUTLINE_HEADING.match(line)
    if not match:
        return None
    title = match.group("title").strip()
    # "1. The tenant shall pay the rent on the first of the month." is a clause,
    # not a heading. Headings do not end in a full stop and are not long.
    if len(title) > 80 or _SENTENCE_END.search(title):
        return None
    if title[:1].islower():
        return None
    parts = match.group("num").split(".")
    return Heading(
        title=title,
        level=min(1 + len(parts), 4),
        page=0,
        page_index=0,
        line_index=0,
        number=int(parts[0]),
        keyword="",
        kind="outline",
        numbering=match.group("num"),
    )


def _match_title_heading(line: str, page: Page) -> Optional[Heading]:
    """Last resort: a short line at the top of a page that reads like a title."""
    if not (3 < len(line) <= 60):
        return None
    if _SENTENCE_END.search(line):
        return None
    words = line.split()
    if not (1 <= len(words) <= 8):
        return None
    if any(ch.isdigit() for ch in line):
        return None

    # A heading is visibly shorter than the body it introduces. Without this
    # the rule fires on the first sentence of every page in the book.
    body = sorted(len(other) for other in page.lines[1:])
    if body:
        median = body[len(body) // 2]
        if len(line) > median * 0.7:
            return None

    return Heading(
        title=line,
        level=2,
        page=0,
        page_index=0,
        line_index=0,
        kind="title",
    )


def find_headings(pages: List[Page], loose: Optional[bool] = None) -> List[Heading]:
    """Scan cleaned pages for headings.

    `loose` forces the title-line fallback on or off; left as None it turns
    itself on only when the reliable signals found fewer than two headings,
    which is the case where a book's chapters are bare titles.
    """
    hebrew_context = detect_language(pages) == "he"
    found: List[Heading] = []

    for page_index, page in enumerate(pages):
        if page.is_toc:
            continue
        for line_index, line in enumerate(page.lines):
            heading = (_match_keyword_heading(line, hebrew_context)
                       or _match_outline_heading(line))
            if heading:
                heading.page = page.number
                heading.page_index = page_index
                heading.line_index = line_index
                found.append(heading)

    found = _drop_contents_pages(found, pages)

    if loose is None:
        loose = len(found) < 2
    if loose:
        guesses: List[Heading] = []
        for page_index, page in enumerate(pages):
            if page.is_toc or not page.lines:
                continue
            if any(h.page_index == page_index for h in found):
                continue
            heading = _match_title_heading(page.lines[0], page)
            if heading:
                heading.page = page.number
                heading.page_index = page_index
                heading.line_index = 0
                guesses.append(heading)

        # If the fallback thinks a third of the pages open a new chapter, it is
        # reading body text, and a wrong index is worse than a coarse one.
        if len(guesses) <= max(4, len(pages) * 0.34):
            found.extend(guesses)

    found.sort(key=lambda h: (h.page_index, h.line_index))
    return _dedupe(found)


def _drop_contents_pages(
    headings: List[Heading], pages: List[Page]
) -> List[Heading]:
    """Throw away the headings on a page that is itself a list of headings.

    A contents page whose dot leaders were lost in extraction still gives
    itself away: six chapter titles and nothing else on the page. A real
    chapter page has one heading and a page of prose under it. Pages caught
    here are marked `is_toc` so the rest of the pipeline treats them as the
    furniture they are.
    """
    by_page: dict = {}
    for heading in headings:
        by_page.setdefault(heading.page_index, []).append(heading)

    contents = set()
    for page_index, on_page in by_page.items():
        page = pages[page_index]
        if len(on_page) >= 4 and len(on_page) >= len(page.lines) * 0.5:
            contents.add(page_index)
            page.is_toc = True

    return [h for h in headings if h.page_index not in contents]


def _dedupe(headings: List[Heading]) -> List[Heading]:
    """Drop a heading repeated on the next page — a running header that survived."""
    out: List[Heading] = []
    for heading in headings:
        clash = next(
            (h for h in reversed(out)
             if h.label == heading.label and heading.page - h.page <= 1),
            None,
        )
        if clash is None:
            out.append(heading)
    return out
