"""Stage 5 — decide what each line *is*, and glue the lines back into prose.

This is where geometry is spent. Up to now a line has been a rectangle with
text in it; from here on it is a heading, a paragraph, a list item, a formula
or a footnote, and the rectangle is gone.

Two sources of evidence are combined, because neither is enough alone. Font
size and weight are decisive when they are there — a 20-point bold line on a
page of 11-point text is a heading whatever it says — but they are absent from
OCR'd pages and meaningless in documents that set everything in one size.
Wording is the other half: `פרק 2`, `3.1 מבוא`, `Chapter Four`. The keyword and
gematria rules for that already exist in `pdf_index/structure.py` and are
imported rather than written again.

The last step is the one that matters most to a reader: joining the lines of a
paragraph back into a paragraph. A PDF has no paragraphs, only lines that
happen to sit under each other, and text extracted line by line arrives full of
breaks that were never in the writing. Where those breaks fall is decided from
the geometry — the gap above a line, its indent, how full the line before it
was — because punctuation alone gets it wrong in Hebrew, which uses neither
capitals nor a full stop that a regex can trust.

Objects (tables, figures) are threaded back in by the reading-order index they
recorded when they were lifted out. Cleaning does not renumber that order, so
the anchors stay valid however many lines the cleaner removed.
"""

from __future__ import annotations

import re
from typing import Dict, Iterable, List, Optional, Sequence, Tuple, Union

from ..pdf_index.structure import match_heading_line
from .model import Block, Figure, Line, PageContent, Table, median
from .objects import looks_like_caption

# Bullets, and the numbered forms a list uses. Hebrew documents number with
# letters — "א." "ב)" — which is also how a gematria chapter number looks, so
# the list rules stay out of the heading rules' way by requiring the marker to
# be followed by real text on the same line.
_BULLET = re.compile(r"^([•▪◦‣∙·●○*\-–—])\s*(\S.*)$")
_NUMBERED = re.compile(
    r"^(\(?(?:\d{1,3}|[ivxlcdm]{1,5}|[a-z]|[א-ת])[.)\]]|\d{1,3}\.\d{1,2}\)?)\s+(\S.*)$"
)

# The same bullet, on the other side. In a right-to-left document the bullet
# is painted at the right margin, and comes back at the *end* of the line —
# "אכיפה של החוזה•". Only the unambiguous bullet characters are read this way:
# a line ending in "1." is far more often a year than a list marker.
_BULLET_RTL = re.compile(r"^(\S.*?)\s*([•▪◦‣∙●○])$")

# The characters that make a line look like mathematics rather than a sentence.
_MATH_CHARS = set("=+−*/^_<>≤≥≈≠±×÷∑∏∫√∞∂∇πθαβγδλμσωΔΩ→←↔⇒⇔∈∉⊆⊂∪∩∀∃¬∧∨")
_MATH_FONT = re.compile(r"(cmmi|cmsy|cmex|mathjax|math|symbol|euclid|mtmi)", re.I)

# A footnote marker at the head of the line: "1.", "¹", "*", "[1]".
_FOOTNOTE_MARKER = re.compile(r"^(\[?\d{1,3}\]?[.)]?|[¹²³⁴⁵⁶⁷⁸⁹⁰]+|[*†‡§]{1,3})\s+(\S.*)$")

_SENTENCE_END = re.compile(r"[.!?:;׃״\"'\)\]]\s*$")
_OPENS_LOWER = re.compile(r"^[a-zà-ÿ]")


# ------------------------------------------------------------ page measures ---


def body_size(pages: Sequence[PageContent]) -> float:
    """The size most of the document's characters are set in.

    Weighted by characters rather than by lines, so that a book whose every
    page carries a two-line heading does not end up calling the heading size
    its body size.
    """
    weights: Dict[float, int] = {}
    for page in pages:
        for line in page.lines:
            key = round(line.size, 1)
            weights[key] = weights.get(key, 0) + len(line.text)
    if not weights:
        return 10.0
    return max(weights.items(), key=lambda kv: kv[1])[0]


def _heading_sizes(pages: Sequence[PageContent], body: float) -> List[float]:
    """The distinct sizes above the body size that stand for levels, largest first.

    Sizes within a few per cent of each other are one level, not two. That
    matters most on an OCR'd page, where "size" is the height of the glyphs
    tesseract drew a box around and the same heading measures 16.2 on one page
    and 17.1 on the next — without the clustering, one chapter comes out as a
    level 2 heading and the next as a level 4.

    Capped at four levels: a document using fifteen distinct larger sizes is
    using them for emphasis, not for hierarchy.
    """
    sizes: Dict[float, int] = {}
    for page in pages:
        for line in page.lines:
            size = round(line.size, 1)
            if size >= body * 1.12:
                sizes[size] = sizes.get(size, 0) + len(line.text)

    ranked: List[float] = []
    for size in sorted((s for s, chars in sizes.items() if chars >= 8), reverse=True):
        if not ranked or size <= ranked[-1] * 0.92:
            ranked.append(size)
    return ranked[:4]


def _line_gaps(page: PageContent) -> float:
    """The usual vertical distance between consecutive lines on this page."""
    gaps = []
    for previous, line in zip(page.lines, page.lines[1:]):
        if line.column != previous.column:
            continue
        gap = line.top - previous.bottom
        if 0 <= gap < previous.height * 4:
            gaps.append(gap)
    return median(gaps) if gaps else 0.0


# ----------------------------------------------------------- line judgement ---


def looks_like_formula(line: Line) -> bool:
    """Is this line mathematics rather than a sentence?

    Two independent signals. The font: TeX sets maths in its own families, and
    a line drawn in CMMI or a Symbol font is an equation whatever its
    characters. Failing that, density: enough operator characters, few enough
    words, and at least one of the symbols that only appear in mathematics.
    """
    text = line.text.strip()
    if len(text) < 2 or len(text) > 200:
        return False

    if any(_MATH_FONT.search(span.font) for span in line.spans):
        return True

    symbols = sum(1 for ch in text if ch in _MATH_CHARS)
    if symbols < 2:
        return False
    letters = sum(1 for ch in text if ch.isalpha())
    words = [w for w in text.split() if len(w) > 2 and w.isalpha()]
    # "Revenue = income - costs" is a sentence with an equals sign in it.
    if len(words) > 4:
        return False
    return symbols / max(len(text), 1) >= 0.08 and letters <= len(text) * 0.6


def _is_footnote(line: Line, page: PageContent, body: float) -> bool:
    """Small text at the foot of the page, opening with a marker.

    All three conditions, deliberately. The foot of the page alone catches the
    last paragraph of every chapter; small text alone catches captions and
    tables; a marker alone catches every numbered list in the document.
    """
    if line.top < page.height * 0.72:
        return False
    if not _FOOTNOTE_MARKER.match(line.text) and not line.superscript_head:
        return False
    return line.size <= body * 0.95


def _heading_level(
    line: Line, body: float, ranks: List[float], hebrew: bool
) -> Optional[int]:
    """The heading level of this line, or None if it is not a heading.

    Size decides the level when the document uses sizes; the wording decides
    it when the document does not. When both speak, size wins the level and
    the wording only has to agree that this is a heading at all — a `פרק`
    printed at body size in a document with real heading sizes is a
    cross-reference in a sentence, not a chapter opening.
    """
    text = line.text.strip()
    if not text or len(text) > 200:
        return None

    size = round(line.size, 1)
    # The same tolerance the size ranking was built with, so a heading that
    # measures a hair under its own level still lands on it.
    by_size = next(
        (i + 1 for i, rank in enumerate(ranks) if size >= rank * 0.96), None
    )
    by_words = match_heading_line(text, hebrew)

    if by_size is not None:
        # A heading is a line of its own. A whole paragraph set large is a
        # pull quote or a cover page, and calling it a heading would swallow
        # the text under it.
        if len(text) > 120:
            return None
        return min(by_size, 6)

    if by_words is not None:
        return min(by_words.level, 6)

    # No size hierarchy anywhere in the document: fall back to weight. Bold,
    # short, and not a sentence — and only when the document gave us nothing
    # better to go on, because bold lead-ins inside paragraphs are common.
    if not ranks and line.bold and len(text) <= 80 and not _SENTENCE_END.search(text):
        return 2
    return None


def classify_lines(
    pages: Sequence[PageContent], body: float, ranks: List[float], hebrew: bool
) -> None:
    """Tag every line with what it is. In place, before any joining happens."""
    for page in pages:
        for line in page.lines:
            text = line.text.strip()
            level = _heading_level(line, body, ranks, hebrew)
            if level is not None:
                line.kind, line.level = "heading", level
                continue
            if _is_footnote(line, page, body):
                line.kind = "footnote"
                continue
            if looks_like_caption(text):
                line.kind = "caption"
                continue
            if looks_like_formula(line):
                line.kind = "formula"
                continue
            if is_list_item(text):
                line.kind = "list"
                continue
            line.kind = "paragraph"


# ------------------------------------------------------------------ joining ---


Item = Union[Line, Table, Figure]


def _page_stream(page: PageContent) -> List[Item]:
    """Lines, tables and figures in one sequence, in reading order."""
    items: List[Tuple[int, int, Item]] = [(l.order, 0, l) for l in page.lines]
    items += [(t.anchor, 1, t) for t in page.tables]
    items += [(f.anchor, 1, f) for f in page.figures]
    items.sort(key=lambda entry: (entry[0], entry[1]))
    return [entry[2] for entry in items]


def is_list_item(text: str) -> bool:
    return bool(_BULLET.match(text) or _NUMBERED.match(text) or _BULLET_RTL.match(text))


def _list_item(text: str) -> Tuple[str, str, bool]:
    """(marker, text, ordered) for a list line, from whichever end the marker is on."""
    bullet = _BULLET.match(text)
    if bullet:
        return bullet.group(1), bullet.group(2).strip(), False
    numbered = _NUMBERED.match(text)
    if numbered:
        return numbered.group(1), numbered.group(2).strip(), True
    trailing = _BULLET_RTL.match(text)
    if trailing:
        return trailing.group(2), trailing.group(1).strip(), False
    return "", text, False


def _starts_new_paragraph(
    line: Line, previous: Line, gap: float, page: PageContent
) -> bool:
    """Did the writer start a new paragraph here, or is the line just full?

    In order of reliability: a wider-than-usual gap above the line; an indent
    that the previous line did not have; and — weakest, so it needs the
    previous line to have ended early as well — a completed sentence above a
    line that could open one.
    """
    if line.page != previous.page:
        return False        # handled by the caller, which knows about pages
    if line.column != previous.column:
        return True

    vertical = line.top - previous.bottom
    if gap > 0 and vertical > gap * 1.8:
        return True

    indent = abs(line.x0 - previous.x0)
    if indent > line.height * 0.9 and vertical <= gap * 1.8:
        # An indent only starts a paragraph when the line before it ran the
        # full width; otherwise it is a centred line or a hanging indent.
        if previous.width >= page.width * 0.55:
            return True

    if _SENTENCE_END.search(previous.text) and previous.width < page.width * 0.62:
        return True
    return False


def _join(left: str, right: str) -> str:
    """Join two lines of one paragraph, healing a word broken across them."""
    left = left.rstrip()
    right = right.lstrip()
    if not left:
        return right
    if not right:
        return left
    if left.endswith("-") and _OPENS_LOWER.match(right):
        return left[:-1] + right
    return f"{left} {right}"


def build_blocks(
    pages: Sequence[PageContent], hebrew: bool = True
) -> Tuple[List[Block], Dict[str, object]]:
    """Turn classified pages into the block sequence the outputs are built from."""
    body = body_size(pages)
    ranks = _heading_sizes(pages, body)
    classify_lines(pages, body, ranks, hebrew)

    blocks: List[Block] = []
    open_block: Optional[Block] = None
    open_line: Optional[Line] = None

    def close() -> None:
        nonlocal open_block, open_line
        if open_block is not None:
            blocks.append(open_block)
        open_block, open_line = None, None

    for page in pages:
        gap = _line_gaps(page)
        for item in _page_stream(page):
            if isinstance(item, Table):
                close()
                blocks.append(
                    Block(kind="table", text=item.caption, pages=[page.number], table=item)
                )
                continue
            if isinstance(item, Figure):
                close()
                blocks.append(
                    Block(kind="figure", text=item.caption, pages=[page.number], figure=item)
                )
                continue

            line = item
            text = line.text.strip()
            if not text:
                continue

            if line.kind in ("heading", "caption", "formula", "footnote"):
                close()
                marker = ""
                content = text
                if line.kind == "footnote":
                    match = _FOOTNOTE_MARKER.match(text)
                    if match:
                        marker, content = match.group(1).strip(".)]["), match.group(2)
                    elif line.superscript_head:
                        marker = line.superscript_head
                        content = text[len(marker):].strip() or text
                blocks.append(
                    Block(
                        kind=line.kind,
                        text=content,
                        pages=[page.number],
                        level=line.level,
                        marker=marker,
                    )
                )
                continue

            if line.kind == "list":
                marker, content, ordered = _list_item(text)
                if open_block is not None and open_block.kind == "list":
                    open_block.items.append(content)
                    if page.number not in open_block.pages:
                        open_block.pages.append(page.number)
                else:
                    close()
                    open_block = Block(
                        kind="list", pages=[page.number], items=[content], ordered=ordered
                    )
                open_block.marker = open_block.marker or marker
                open_line = line
                continue

            # A paragraph line. It either continues the open block or starts a
            # new one — including across a page break, where a sentence left
            # unfinished at the foot of one page continues at the head of the
            # next.
            if open_block is not None and open_block.kind == "list":
                # An unmarked line under a list item is that item's second line.
                if open_line is not None and line.x0 >= open_line.x0 - 2 and not _SENTENCE_END.search(open_block.items[-1]):
                    open_block.items[-1] = _join(open_block.items[-1], text)
                    continue
                close()

            if open_block is not None and open_line is not None:
                crossed_page = line.page != open_line.page
                if crossed_page:
                    broken = not _SENTENCE_END.search(open_block.text)
                    starts_over = is_list_item(text)
                    if broken and not starts_over:
                        open_block.text = _join(open_block.text, text)
                        if page.number not in open_block.pages:
                            open_block.pages.append(page.number)
                        open_line = line
                        continue
                    close()
                elif not _starts_new_paragraph(line, open_line, gap, page):
                    open_block.text = _join(open_block.text, text)
                    open_line = line
                    continue
                else:
                    close()

            open_block = Block(kind="paragraph", text=text, pages=[page.number])
            open_line = line

    close()

    stats = {
        "body_size": body,
        "heading_sizes": ranks,
        "blocks": len(blocks),
    }
    return blocks, stats


def document_title(
    blocks: Iterable[Block], meta_title: str = "", fallback: str = ""
) -> str:
    """The document's name: what it says it is called, then what it looks like.

    The PDF's own metadata title is used when it is a title rather than a
    left-over file name — producers routinely write "Microsoft Word -
    final_v3.doc" in there, which names the file the author had open, not the
    document.
    """
    candidate = (meta_title or "").strip()
    plausible = (
        len(candidate) >= 4
        and not re.search(r"\.(docx?|pdf|indd|pptx?|tex|pages)\b", candidate, re.I)
        and not re.match(r"^(untitled|document\d*|microsoft word)", candidate, re.I)
    )
    if plausible:
        return candidate

    for block in blocks:
        if block.kind == "heading" and block.page <= 2 and block.level <= 2:
            return block.text.strip()

    return fallback or "Document"
