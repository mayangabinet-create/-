"""The shapes every stage passes to the next.

Two levels of description live here, and keeping them apart is what makes the
pipeline testable. `Line`, `Table`, `Figure` and `PageContent` are *what the
page physically contains* — text with a font size and a rectangle around it,
straight off the PDF. `Block` is *what the document means* — a heading, a
paragraph, a list — with the geometry already spent and thrown away.

Everything after `blocks.py` sees only `Block`s, so a page of two columns and
a page of one column are indistinguishable by then, and so are a page that was
read and a page that was OCR'd.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

BBox = Tuple[float, float, float, float]

HEBREW_RANGE = re.compile("[֐-׿]")
ARABIC_RANGE = re.compile("[؀-ۿ]")
LATIN_RANGE = re.compile("[A-Za-z]")

# Font flags as PyMuPDF reports them, named so the classifier reads as prose.
FLAG_SUPERSCRIPT = 1
FLAG_ITALIC = 2
FLAG_SERIF = 4
FLAG_MONOSPACE = 8
FLAG_BOLD = 16


@dataclass
class Span:
    """A run of characters that share one font, size and colour."""

    text: str
    size: float
    font: str
    flags: int
    bbox: BBox

    @property
    def bold(self) -> bool:
        # Some producers never set the flag and encode weight in the font name
        # only ("Arial-BoldMT"), so both are consulted.
        return bool(self.flags & FLAG_BOLD) or "bold" in self.font.lower()

    @property
    def italic(self) -> bool:
        return bool(self.flags & FLAG_ITALIC) or "italic" in self.font.lower()

    @property
    def superscript(self) -> bool:
        return bool(self.flags & FLAG_SUPERSCRIPT)


@dataclass
class Line:
    """One visual line of text, with everything needed to judge what it is.

    `size` is the size of the span holding most of the line's characters, not
    the maximum: a paragraph containing one superscript footnote marker is
    still a paragraph, and the marker must not lift its measured size.
    """

    text: str
    page: int
    bbox: BBox
    size: float
    bold: bool
    spans: List[Span] = field(default_factory=list)
    column: int = 0
    order: int = 0
    # Whether the text had a space at its edge before it was stripped. A line
    # arrives split into bidi runs whose boxes touch, so the space that
    # separates two words is often only recorded here.
    pad_left: bool = False
    pad_right: bool = False
    # Filled by blocks.py. Kept on the line rather than in a side table so that
    # a misclassified line can be found by dumping the page.
    kind: str = ""
    level: int = 0

    @property
    def x0(self) -> float:
        return self.bbox[0]

    @property
    def x1(self) -> float:
        return self.bbox[2]

    @property
    def top(self) -> float:
        return self.bbox[1]

    @property
    def bottom(self) -> float:
        return self.bbox[3]

    @property
    def width(self) -> float:
        return self.bbox[2] - self.bbox[0]

    @property
    def height(self) -> float:
        return max(self.bbox[3] - self.bbox[1], 1.0)

    @property
    def superscript_head(self) -> str:
        """The leading superscript run, if the line opens with one.

        This is how a footnote gives itself away when the producer bothered to
        mark it: the body of the note is normal text, but its number is set as
        a superscript.
        """
        for span in self.spans:
            if not span.text.strip():
                continue
            return span.text.strip() if span.superscript else ""
        return ""


@dataclass
class Table:
    """A grid recovered from the page, kept as rows of cells.

    `anchor` is the index in the page's line order where the table's first
    swallowed line sat, so the table can be put back exactly where it was
    rather than at the end of the page.
    """

    page: int
    bbox: BBox
    rows: List[List[str]]
    header: List[str] = field(default_factory=list)
    anchor: int = 0
    caption: str = ""
    id: str = ""

    @property
    def n_rows(self) -> int:
        return len(self.rows)

    @property
    def n_cols(self) -> int:
        return max((len(row) for row in self.rows), default=0)


@dataclass
class Figure:
    """An image or a vector drawing, with whatever caption sits next to it."""

    page: int
    bbox: BBox
    kind: str = "image"          # image | drawing
    caption: str = ""
    anchor: int = 0
    xref: int = 0
    width: int = 0
    height: int = 0
    asset: str = ""              # path, relative to the output directory
    id: str = ""


@dataclass
class PageContent:
    """One page, after reading and before cleaning."""

    number: int
    width: float
    height: float
    lines: List[Line] = field(default_factory=list)
    tables: List[Table] = field(default_factory=list)
    figures: List[Figure] = field(default_factory=list)
    source: str = "text"         # text | ocr
    is_toc: bool = False
    dropped: List[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n".join(line.text for line in self.lines)

    @property
    def char_count(self) -> int:
        return sum(len(line.text) for line in self.lines)


@dataclass
class Block:
    """A unit of meaning: what the Markdown renders and the JSON indexes.

    `kind` is one of title, heading, paragraph, list, table, figure, formula,
    footnote, caption, quote. `pages` is every page the block draws from — a
    paragraph continued across a page break belongs to both.
    """

    kind: str
    text: str = ""
    pages: List[int] = field(default_factory=list)
    level: int = 0
    items: List[str] = field(default_factory=list)
    ordered: bool = False
    table: Optional[Table] = None
    figure: Optional[Figure] = None
    marker: str = ""
    id: str = ""
    md_start: int = 0
    md_end: int = 0

    @property
    def page(self) -> int:
        return self.pages[0] if self.pages else 0

    @property
    def char_count(self) -> int:
        if self.items:
            return sum(len(item) for item in self.items)
        if self.table is not None:
            return sum(len(cell) for row in self.table.rows for cell in row)
        return len(self.text)


@dataclass
class Section:
    """A heading and everything under it — the outline the JSON publishes."""

    title: str
    level: int
    page_start: int
    page_end: int
    block_index: int
    id: str = ""
    children: List["Section"] = field(default_factory=list)
    parent: Optional["Section"] = field(default=None, repr=False, compare=False)

    @property
    def path(self) -> List[str]:
        names: List[str] = []
        node: Optional["Section"] = self
        while node is not None:
            names.append(node.title)
            node = node.parent
        return list(reversed(names))

    def walk(self):
        yield self
        for child in self.children:
            yield from child.walk()


@dataclass
class Chunk:
    """A slice of the document sized for one AI call, and where it came from."""

    id: str
    heading_path: List[str]
    level: int
    page_start: int
    page_end: int
    block_ids: List[str] = field(default_factory=list)
    terms: List[str] = field(default_factory=list)
    chars: int = 0
    md_start: int = 0
    md_end: int = 0
    part: int = 1
    parts: int = 1


@dataclass
class Document:
    """Everything the two output files are written from."""

    path: str
    title: str
    language: str = "en"
    direction: str = "ltr"
    page_count: int = 0
    blocks: List[Block] = field(default_factory=list)
    sections: List[Section] = field(default_factory=list)
    chunks: List[Chunk] = field(default_factory=list)
    pages: List[PageContent] = field(default_factory=list)
    meta: Dict = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)

    def of_kind(self, kind: str) -> List[Block]:
        return [b for b in self.blocks if b.kind == kind]


def script_ratio(text: str) -> Tuple[int, int]:
    """(right-to-left letters, latin letters) — the whole basis for direction."""
    rtl = len(HEBREW_RANGE.findall(text)) + len(ARABIC_RANGE.findall(text))
    return rtl, len(LATIN_RANGE.findall(text))


def median(values: Sequence[float]) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[middle])
    return (ordered[middle - 1] + ordered[middle]) / 2.0
