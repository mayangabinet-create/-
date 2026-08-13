"""Stage 2 — put the lines in the order a person would read them.

A PDF stores marks on a page, not a sequence of sentences. On a single-column
page the two coincide closely enough that sorting by vertical position works.
On a two-column page it does not: read top to bottom and every line of column
one is followed by the wrong line of column two, and the document becomes
interleaved nonsense that no amount of later cleaning can undo.

So columns are found first, from the gaps in the page's own geometry, and each
column is read out whole. Which column comes first depends on the document's
direction — a Hebrew page runs right to left, and so do its columns.
"""

from __future__ import annotations

import re
from typing import List, Tuple

from .model import Line, PageContent, median, script_ratio


def document_direction(pages: List[PageContent]) -> Tuple[str, str]:
    """(direction, language) for the document as a whole.

    Decided over the whole document rather than per page, because a Hebrew
    book with an English bibliography is still a Hebrew book, and flipping
    column order halfway through it would be worse than being wrong once.
    """
    sample = "\n".join(page.text for page in pages[:60])[:40000]
    rtl, latin = script_ratio(sample)
    if rtl > latin:
        return "rtl", "he"
    return "ltr", "en"


Gutter = Tuple[float, float]     # (left edge, right edge) of the white channel

_BINS = 160


def find_gutters(lines: List[Line], page_width: float) -> List[Gutter]:
    """The vertical white channels that run down the page.

    Measured as a coverage histogram rather than by walking the lines from
    left to right, because of what sits in a real gutter: a running header, a
    centred page number, a heading set across both columns. Any one of those
    closes the channel if a gutter is defined as space *nothing* crosses, and
    the page is then read as one column and comes out interleaved.

    So a channel is allowed a few crossings — it just has to be mostly empty,
    and wide. What crosses it is dealt with separately, in `sort_page`.
    """
    if len(lines) < 6 or page_width <= 0:
        return []

    step = page_width / _BINS
    coverage = [0] * _BINS
    for line in lines:
        first = max(0, min(_BINS - 1, int(line.x0 / step)))
        last = max(0, min(_BINS - 1, int(line.x1 / step)))
        for index in range(first, last + 1):
            coverage[index] += 1

    # A tenth of the lines may cross the channel — that is a heading and a
    # header, not a column boundary that is not there.
    ceiling = max(1, int(len(lines) * 0.12))
    min_width = max(page_width * 0.035, 14.0)
    margin = int(_BINS * 0.08)      # the page's own margins are not gutters

    gutters: List[Gutter] = []
    index = margin
    while index < _BINS - margin:
        if coverage[index] > ceiling:
            index += 1
            continue
        start = index
        while index < _BINS - margin and coverage[index] <= ceiling:
            index += 1
        if (index - start) * step < min_width:
            continue
        left, right = start * step, index * step
        # A channel with nothing past it is a margin, not a gutter: a page of
        # short lines has white space down its right-hand side, and reading
        # that as a second column would put every line in a column of its own.
        if any(line.x0 >= right for line in lines) and any(
            line.x1 <= left for line in lines
        ):
            gutters.append((left, right))
    return gutters


def _assign_columns(lines: List[Line], gutters: List[Gutter]) -> int:
    for line in lines:
        centre = (line.x0 + line.x1) / 2.0
        line.column = sum(1 for _, right in gutters if centre >= right)
    return len(gutters) + 1


def _crosses(line: Line, gutter: Gutter) -> bool:
    """Does this line run across the channel rather than beside it?"""
    left, right = gutter
    return line.x0 <= left + 1 and line.x1 >= right - 1


def detect_columns(page: PageContent, min_share: float = 0.12) -> List[Gutter]:
    """Find the page's columns and tag every line with the one it belongs to.

    A gutter is only believed when both sides carry a real share of the page's
    text. Otherwise a page whose one wide element is a two-cell header row
    would be read as two columns, and its body shredded to fit a layout it
    does not have.
    """
    lines = page.lines
    for line in lines:
        line.column = 0
    if not lines:
        return []

    gutters = find_gutters(lines, page.width)
    if not gutters:
        return []

    count = _assign_columns(lines, gutters)
    chars = [0] * count
    for line in lines:
        if not any(_crosses(line, gutter) for gutter in gutters):
            chars[line.column] += len(line.text)
    total = sum(chars) or 1

    keep = [
        gutter
        for index, gutter in enumerate(gutters)
        if chars[index] / total >= min_share and chars[index + 1] / total >= min_share
    ]
    if keep != gutters:
        if not keep:
            for line in lines:
                line.column = 0
            return []
        _assign_columns(lines, keep)
    return keep


def _same_row(a: Line, b: Line, tolerance: float) -> bool:
    """Are these two lines on the same visual line of the page?

    A line broken into several boxes by a change of font — a bold lead-in, a
    footnote marker — comes back as separate pieces that have to be read left
    to right (or right to left) rather than as two lines.
    """
    return abs(a.top - b.top) <= tolerance


def _merge(fragments: List[Line], direction: str) -> Line:
    """Fuse the pieces of one visual line into a single line.

    A right-to-left PDF hands back a heading like `פרק 1 — חוזים` as four
    separate lines, one per bidi run, in the order the runs were painted.
    Left as they are, each becomes a heading of its own and the document grows
    four chapters where it has one. The same happens on the Latin side
    whenever a line changes font mid-way.

    Whether a space goes between two pieces is decided by the space actually
    on the page, so a word split across two spans by a bold first letter comes
    back as one word.
    """
    if len(fragments) == 1:
        return fragments[0]

    text = fragments[0].text
    for previous, piece in zip(fragments, fragments[1:]):
        gap = (
            piece.x0 - previous.x1 if direction == "ltr" else previous.x0 - piece.x1
        )
        # A space if the page had one — recorded as a stripped edge space, or
        # visible as a gap the width of one. Two pieces that truly touch are
        # one word split by a change of font, and get nothing between them.
        spaced = (
            previous.pad_right
            or piece.pad_left
            or gap >= max(previous.size * 0.18, 0.8)
        )
        text += (" " if spaced else "") + piece.text

    weights: dict = {}
    bold = 0
    for piece in fragments:
        weights[piece.size] = weights.get(piece.size, 0) + len(piece.text)
        if piece.bold:
            bold += len(piece.text)

    head = fragments[0]
    return Line(
        text=re.sub(r" {2,}", " ", text).strip(),
        page=head.page,
        bbox=(
            min(f.bbox[0] for f in fragments),
            min(f.bbox[1] for f in fragments),
            max(f.bbox[2] for f in fragments),
            max(f.bbox[3] for f in fragments),
        ),
        size=max(weights.items(), key=lambda kv: kv[1])[0],
        bold=bold * 2 > sum(len(f.text) for f in fragments),
        spans=[span for piece in fragments for span in piece.spans],
        column=head.column,
        pad_left=fragments[0].pad_left,
        pad_right=fragments[-1].pad_right,
    )


def _runs(row: List[Line], direction: str, page_width: float) -> List[List[Line]]:
    """Split one visual row where the space between pieces is too wide to be a space.

    Two paragraphs side by side are a row of two runs, not one sentence. The
    threshold is generous — three times the text size — because the gap inside
    a justified line can be wide, and mistaking one line for two costs less
    than gluing two columns together.
    """
    runs: List[List[Line]] = [[row[0]]]
    for previous, piece in zip(row, row[1:]):
        gap = piece.x0 - previous.x1 if direction == "ltr" else previous.x0 - piece.x1
        limit = max(previous.size * 3.0, page_width * 0.05)
        if gap > limit:
            runs.append([piece])
        else:
            runs[-1].append(piece)
    return runs


def _rows(lines: List[Line], tolerance: float, direction: str, page_width: float) -> List[Line]:
    """One column's lines, top to bottom, each visual line fused into one."""
    grouped: List[List[Line]] = []
    for line in sorted(lines, key=lambda l: (l.top, l.x0)):
        if grouped and _same_row(grouped[-1][0], line, tolerance):
            grouped[-1].append(line)
        else:
            grouped.append([line])

    ordered: List[Line] = []
    for row in grouped:
        row.sort(key=lambda l: l.x0, reverse=(direction == "rtl"))
        for run in _runs(row, direction, page_width):
            merged = _merge(run, direction)
            if merged.text:
                ordered.append(merged)
    return ordered


def _by_column(
    lines: List[Line], tolerance: float, direction: str, page_width: float
) -> List[Line]:
    columns: dict = {}
    for line in lines:
        columns.setdefault(line.column, []).append(line)
    ordered: List[Line] = []
    # Column 0 is the leftmost; in a right-to-left document it is read last.
    for index in sorted(columns, reverse=(direction == "rtl")):
        ordered.extend(_rows(columns[index], tolerance, direction, page_width))
    return ordered


def sort_page(page: PageContent, direction: str = "ltr") -> List[Line]:
    """Reading order for one page, in place.

    On a single-column page this is top to bottom. On a page with columns it
    is band by band: a line that runs across the gutter — a title, a
    full-width figure caption, a footer — ends the band above it and starts a
    new one, and the columns inside each band are read out whole.

    That banding is what keeps a two-column page under a spanning heading in
    the right order, and it is also what stops a spanning line halfway down
    the page from being teleported to the top.

    Every line gets its `order` index here, which is what tables and figures
    anchor themselves to when they claim a position in the flow.
    """
    if not page.lines:
        return page.lines

    gutters = detect_columns(page)
    tolerance = max(median([line.height for line in page.lines]) * 0.5, 2.0)

    if not gutters:
        ordered = _rows(page.lines, tolerance, direction, page.width)
    else:
        spanning = [
            line
            for line in page.lines
            if any(_crosses(line, gutter) for gutter in gutters)
        ]
        rest = [line for line in page.lines if line not in spanning]
        spanning.sort(key=lambda l: l.top)

        ordered = []
        ceiling = float("-inf")
        for divider in spanning:
            band = [line for line in rest if ceiling <= line.top < divider.top]
            ordered.extend(_by_column(band, tolerance, direction, page.width))
            ordered.append(divider)
            ceiling = max(ceiling, divider.top)
        ordered.extend(
            _by_column(
                [line for line in rest if line.top >= ceiling],
                tolerance, direction, page.width,
            )
        )

    for position, line in enumerate(ordered):
        line.order = position
    page.lines = ordered
    return ordered


def sort_pages(pages: List[PageContent], direction: str = "ltr") -> None:
    for page in pages:
        sort_page(page, direction)
