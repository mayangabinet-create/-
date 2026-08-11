"""Stage 4 — turn headings into chapters with page ranges, and print the index.

A heading is a point; a chapter is a span. A chapter runs from its own
heading to the next heading at the same level or higher — a sub-section
starting on page 30 does not end chapter 2, but the next chapter does.

The printed shape is the one the model reads first:

    פרק 1 — חוזים ........ עמודים 1-24
    פרק 2 — מיסוי ........ עמודים 25-67
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional

from .extract import Page
from .structure import Heading, detect_language

LABELS = {
    "he": {"index": "אינדקס", "pages": "עמודים", "page": "עמוד",
           "front": "פתח דבר", "relevant": "תוכן רלוונטי",
           "nothing": "לא נמצא קטע מתאים לשאלה."},
    "en": {"index": "INDEX", "pages": "pages", "page": "page",
           "front": "Front matter", "relevant": "RELEVANT CONTENT",
           "nothing": "No passage in this document matched the question."},
}


@dataclass
class Chapter:
    """One span of the document, addressable by number or by page."""

    label: str
    title: str
    level: int
    start_page: int
    end_page: int
    lines: List[str] = field(default_factory=list)
    number: Optional[int] = None
    keyword: str = ""
    children: List["Chapter"] = field(default_factory=list)
    parent: Optional["Chapter"] = field(default=None, repr=False, compare=False)

    @property
    def text(self) -> str:
        return "\n".join(self.lines)

    @property
    def path_label(self) -> str:
        """"פרק 2 — מיסוי › סעיף 5 — הרחבה".

        A retrieved passage cites this, not the bare section title: told only
        that a paragraph comes from "section 5", the model has no idea which
        chapter it is reading, and neither does the reader checking it.
        """
        names = []
        node: Optional["Chapter"] = self
        while node is not None:
            names.append(node.label.strip() or node.title)
            node = node.parent
        return " › ".join(reversed(names))

    @property
    def char_count(self) -> int:
        return len(self.text)

    @property
    def page_range(self) -> str:
        if self.start_page == self.end_page:
            return str(self.start_page)
        return f"{self.start_page}-{self.end_page}"

    def walk(self):
        yield self
        for child in self.children:
            yield from child.walk()

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "title": self.title,
            "level": self.level,
            "number": self.number,
            "start_page": self.start_page,
            "end_page": self.end_page,
            "chars": self.char_count,
            "children": [c.to_dict() for c in self.children],
        }


def _slice_lines(
    pages: List[Page],
    start: tuple,
    end: Optional[tuple],
) -> List[str]:
    """Lines from (page_index, line_index) up to but not including `end`."""
    out: List[str] = []
    last_page = len(pages) - 1 if end is None else end[0]
    for page_index in range(start[0], min(last_page, len(pages) - 1) + 1):
        lines = pages[page_index].lines
        first = start[1] if page_index == start[0] else 0
        stop = end[1] if (end is not None and page_index == end[0]) else len(lines)
        out.extend(lines[first:stop])
    return out


def build_index(pages: List[Page], headings: List[Heading]) -> List[Chapter]:
    """Chapters in document order, nested by level.

    Any text before the first heading becomes a front-matter chapter, so a
    preface is still retrievable instead of being silently dropped.
    """
    if not pages:
        return []

    language = detect_language(pages)
    flat: List[Chapter] = []

    if not headings:
        return [
            Chapter(
                label=LABELS[language]["front"],
                title=LABELS[language]["front"],
                level=1,
                start_page=pages[0].number,
                end_page=pages[-1].number,
                lines=[line for page in pages for line in page.lines],
            )
        ]

    first = headings[0]
    if first.page_index > 0 or first.line_index > 0:
        lines = _slice_lines(pages, (0, 0), (first.page_index, first.line_index))
        if sum(len(line) for line in lines) > 200:
            flat.append(
                Chapter(
                    label=LABELS[language]["front"],
                    title=LABELS[language]["front"],
                    level=1,
                    start_page=pages[0].number,
                    end_page=first.page,
                    lines=lines,
                )
            )

    for i, heading in enumerate(headings):
        # The chapter's text stops at the next heading of any level — a
        # sub-section's text belongs to the sub-section, not to both.
        following = headings[i + 1] if i + 1 < len(headings) else None
        end_pos = (following.page_index, following.line_index) if following else None
        lines = _slice_lines(
            pages, (heading.page_index, heading.line_index + 1), end_pos
        )

        # The page range, though, covers everything under this heading,
        # including its sub-sections — that is what a reader looks up.
        closing = next(
            (h for h in headings[i + 1:] if h.level <= heading.level), None
        )
        if closing is None:
            end_page = pages[-1].number
        else:
            end_page = max(heading.page, closing.page - 1)

        flat.append(
            Chapter(
                label=heading.label,
                title=heading.title,
                level=heading.level,
                start_page=heading.page,
                end_page=end_page,
                lines=lines,
                number=heading.number,
                keyword=heading.keyword,
            )
        )

    return _nest(flat)


def _nest(flat: List[Chapter]) -> List[Chapter]:
    """Attach each chapter to the nearest shallower one before it."""
    roots: List[Chapter] = []
    stack: List[Chapter] = []
    for chapter in flat:
        while stack and stack[-1].level >= chapter.level:
            stack.pop()
        if stack:
            stack[-1].children.append(chapter)
            chapter.parent = stack[-1]
        else:
            roots.append(chapter)
        stack.append(chapter)
    return roots


def flatten(chapters: List[Chapter]) -> List[Chapter]:
    return [c for root in chapters for c in root.walk()]


def render_index(
    chapters: List[Chapter],
    language: str = "he",
    width: int = 46,
    max_level: int = 2,
) -> str:
    """The index as the model should see it: one line per chapter, page range last.

    Dot leaders are cosmetic for a human, but they also stop a title and a
    page number running together into one token.
    """
    words = LABELS.get(language, LABELS["en"])
    out = [words["index"], ""]

    for chapter in flatten(chapters):
        if chapter.level > max_level:
            continue
        indent = "  " * (chapter.level - 1)
        label = indent + (chapter.label.strip() or chapter.title)
        pad = max(4, width - len(label))
        pages_word = words["pages"] if chapter.start_page != chapter.end_page else words["page"]
        out.append(f"{label} {'.' * pad} {pages_word} {chapter.page_range}")

    return "\n".join(out)


def find_chapter(
    chapters: List[Chapter], selector: str
) -> Optional[Chapter]:
    """Look a chapter up by number ("2"), by page ("p31") or by title text."""
    all_chapters = flatten(chapters)
    selector = selector.strip()

    page_match = re.fullmatch(r"[pP]\.?\s*(\d{1,4})", selector)
    if page_match:
        page = int(page_match.group(1))
        hits = [c for c in all_chapters if c.start_page <= page <= c.end_page]
        # The deepest chapter covering that page is the most specific answer.
        return max(hits, key=lambda c: c.level) if hits else None

    if selector.isdigit():
        number = int(selector)
        for level in (2, 1, 3, 4):
            hit = next(
                (c for c in all_chapters
                 if c.number == number and c.level == level),
                None,
            )
            if hit:
                return hit

    needle = selector.lower()
    return next(
        (c for c in all_chapters if needle and needle in c.label.lower()), None
    )
