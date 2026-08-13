"""Stage 3 — the things on the page that are not prose.

Tables and figures have to be lifted out *before* the text is turned into
paragraphs, for the same reason in both cases: their text is not prose and
must not be joined into any. A table read as sentences becomes a run of
disconnected fragments — "שם 12 סכום 40 סהכ" — that is worse than useless to a
model, and a chart's axis labels do the same on a smaller scale.

What is lifted keeps its place. Every object records the reading-order index
of the first line it swallowed, so the Markdown puts it back exactly where it
stood rather than herding all the tables to the end of the page.
"""

from __future__ import annotations

import os
import re
from typing import List, Optional, Tuple

from .model import BBox, Figure, PageContent, Table
from .read import normalise, raw_page

# "איור 3:", "תרשים 2 —", "Figure 4.", "Table 2:" — the words a caption starts
# with. A line that opens with one is a caption; a line that merely mentions a
# figure is not, which is why the match is anchored.
CAPTION_WORDS = (
    "איור", "תרשים", "תמונה", "טבלה", "לוח", "גרף", "שרטוט", "תרשים זרימה",
    "figure", "fig", "table", "chart", "diagram", "image", "exhibit", "plate",
)

_CAPTION = re.compile(
    r"^(?:" + "|".join(CAPTION_WORDS) + r")\s*\.?\s*"
    r"(?:[\dא-ת]{1,4}(?:\.\d{1,2})?)?\s*[:.\-–—)]?\s+\S",
    re.IGNORECASE,
)

# Below this, an image is a logo, a bullet glyph or a hairline rule.
_MIN_FIGURE_AREA = 0.012      # of the page
_MIN_FIGURE_SIDE = 42.0       # points


def looks_like_caption(text: str) -> bool:
    return bool(_CAPTION.match(text.strip()))


def _overlap(a: BBox, b: BBox) -> float:
    """Fraction of `a` covered by `b`."""
    width = min(a[2], b[2]) - max(a[0], b[0])
    height = min(a[3], b[3]) - max(a[1], b[1])
    if width <= 0 or height <= 0:
        return 0.0
    area = max((a[2] - a[0]) * (a[3] - a[1]), 1e-6)
    return (width * height) / area


def _position_for(page: PageContent, bbox: BBox) -> int:
    """Where an object belongs in the reading order, without taking any text.

    The first line below the object, because that is the line the object was
    printed above; failing that, the end of the page.
    """
    below = [line for line in page.lines if line.top >= bbox[3]]
    if below:
        return min(line.order for line in below)
    return max((line.order for line in page.lines), default=-1) + 1


def _swallow(page: PageContent, bbox: BBox, threshold: float = 0.6) -> int:
    """Remove the lines that lie inside `bbox` and return where they started.

    The returned anchor is the reading-order index of the first line removed,
    which is the position the object will be re-inserted at.
    """
    inside = [line for line in page.lines if _overlap(line.bbox, bbox) >= threshold]
    if not inside:
        return _position_for(page, bbox)
    anchor = min(line.order for line in inside)
    page.lines = [line for line in page.lines if line not in inside]
    return anchor


def _clean_cell(value: Optional[str]) -> str:
    """One cell, with its internal line breaks turned into spaces.

    A newline inside a Markdown table cell ends the row, so a wrapped cell
    would silently truncate the table if it were left in.
    """
    return normalise((value or "").replace("\n", " "))


def _join_spans(spans: List, direction: str) -> str:
    """One cell's spans, read in order and spaced the way the page spaced them.

    The same rule the line merger uses: a space goes in where the page has one
    — recorded in the span's own text, or visible as a gap the width of one —
    and nowhere else, so `ש"ח` does not come back as `ש " ח`.
    """
    if not spans:
        return ""

    tolerance = max(max(span.size for span in spans) * 0.5, 2.0)
    rows: List[List] = []
    for span in sorted(spans, key=lambda s: (s.bbox[1], s.bbox[0])):
        if rows and abs(rows[-1][0].bbox[1] - span.bbox[1]) <= tolerance:
            rows[-1].append(span)
        else:
            rows.append([span])

    out: List[str] = []
    for row in rows:
        row.sort(key=lambda s: s.bbox[0], reverse=(direction == "rtl"))
        text = row[0].text
        for previous, span in zip(row, row[1:]):
            gap = (
                span.bbox[0] - previous.bbox[2]
                if direction == "ltr"
                else previous.bbox[0] - span.bbox[2]
            )
            spaced = (
                previous.text.endswith(" ")
                or span.text.startswith(" ")
                or gap >= max(previous.size * 0.18, 0.8)
            )
            text += (" " if spaced else "") + span.text
        out.append(text.strip())
    return _clean_cell(" ".join(part for part in out if part))


def _cells_text(page: PageContent, boxes, direction: str) -> List[str]:
    """Read a row of cell rectangles out of the page's own spans."""
    spans = [span for line in page.lines for span in line.spans]
    out: List[str] = []
    for box in boxes:
        if box is None:
            out.append("")
            continue
        inside = [
            span
            for span in spans
            if span.text.strip() and _overlap(span.bbox, tuple(box)) >= 0.7  # type: ignore[arg-type]
        ]
        out.append(_join_spans(inside, direction))
    return out


def _rebuild_cells(
    page: PageContent, candidate, rows: List[List[str]], direction: str
) -> List[List[str]]:
    """Re-read each cell from the spans we already have, in reading order.

    The table finder reads its own text straight off the page, which on a
    right-to-left document means reading it backwards: `מדרגה` comes back as
    `הגרדמ`. Our spans have been through direction repair and normalisation,
    so wherever a cell's rectangle contains spans of ours, those are the
    better text.

    Spans rather than lines, because by this point the lines of a table row
    have been fused into one line each — that fusing is what makes an ordinary
    right-to-left line readable, and it is exactly wrong across a cell border.

    Cells with nothing of ours inside — a cell holding an image, a page read
    by OCR — keep whatever the finder made of them.
    """
    table_rows = getattr(candidate, "rows", None)
    if not table_rows or not page.lines:
        return rows

    for row_index, table_row in enumerate(table_rows):
        if row_index >= len(rows):
            break
        boxes = getattr(table_row, "cells", []) or []
        for column_index, text in enumerate(_cells_text(page, boxes, direction)):
            if text and column_index < len(rows[row_index]):
                rows[row_index][column_index] = text
    return rows


def _table_is_worth_keeping(rows: List[List[str]]) -> bool:
    """Reject the grids that are really just ruled boxes around prose.

    A one-column "table" is a framed paragraph; a table whose cells are almost
    all empty is a layout grid used for positioning. Both are better read as
    the text they contain.
    """
    if len(rows) < 2:
        return False
    width = max((len(row) for row in rows), default=0)
    if width < 2:
        return False
    cells = [cell for row in rows for cell in row]
    filled = [cell for cell in cells if cell]
    if len(filled) < max(3, len(cells) * 0.3):
        return False
    return True


def find_tables(
    page: PageContent, direction: str = "ltr", max_tables: int = 12
) -> List[Table]:
    """Recover ruled and whitespace-aligned grids from one page.

    PyMuPDF's own finder does the work — it reads the ruling lines when there
    are any and falls back to column alignment when there are not. What is
    added here is judgement about which of its answers to believe, and the
    bookkeeping that keeps a kept table in its place in the text.
    """
    raw = raw_page(page)
    if raw is None or not hasattr(raw, "find_tables"):
        return []

    try:
        found = raw.find_tables()
    except (RuntimeError, ValueError, TypeError):
        return []

    tables: List[Table] = []
    for candidate in list(found)[:max_tables]:
        try:
            extracted = candidate.extract()
        except (RuntimeError, ValueError, TypeError):
            continue

        rows = [[_clean_cell(cell) for cell in row] for row in extracted]
        rows = _rebuild_cells(page, candidate, rows, direction)
        rows = [row for row in rows if any(cell for cell in row)]
        if not _table_is_worth_keeping(rows):
            continue

        bbox = tuple(float(v) for v in candidate.bbox)  # type: ignore[assignment]
        header: List[str] = []
        # PyMuPDF marks the header row it believes in. When that row is the
        # table's own first row, it is already in `rows` — promoting it is
        # cheaper and more accurate than reading it twice, and avoids printing
        # it twice. A header drawn above the grid has to be read separately.
        found_header = getattr(candidate, "header", None)
        if found_header is not None and getattr(found_header, "names", None):
            if getattr(found_header, "external", False):
                header = _cells_text(page, getattr(found_header, "cells", []), direction)
            elif rows:
                header, rows = rows[0], rows[1:]
            if not any(header):
                header = []

        if not rows:
            continue

        tables.append(
            Table(
                page=page.number,
                bbox=bbox,
                rows=rows,
                header=header,
                anchor=_swallow(page, bbox),
            )
        )

    return tables


def _figure_candidates(page: PageContent, include_drawings: bool) -> List[Tuple[BBox, str, dict]]:
    raw = raw_page(page)
    if raw is None:
        return []

    page_area = max(page.width * page.height, 1.0)
    out: List[Tuple[BBox, str, dict]] = []

    try:
        images = raw.get_image_info(xrefs=True)
    except (RuntimeError, ValueError, TypeError):
        images = []
    # A scanned page is one image of the whole page. It is not an illustration
    # in the document, it *is* the document, and listing it as a figure gives
    # a 300-page scan 300 meaningless figures.
    page_filling = 0.6 if page.source == "ocr" else 0.9

    for image in images:
        bbox = tuple(float(v) for v in image.get("bbox", (0, 0, 0, 0)))
        width, height = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if width < _MIN_FIGURE_SIDE or height < _MIN_FIGURE_SIDE:
            continue
        share = (width * height) / page_area
        if share < _MIN_FIGURE_AREA or share >= page_filling:
            continue
        out.append((
            bbox,
            "image",
            {
                "xref": int(image.get("xref", 0) or 0),
                "width": int(image.get("width", 0) or 0),
                "height": int(image.get("height", 0) or 0),
            },
        ))

    if include_drawings and hasattr(raw, "cluster_drawings"):
        try:
            drawings = raw.get_drawings()
            clusters = raw.cluster_drawings()
        except (RuntimeError, ValueError, TypeError):
            drawings, clusters = [], []
        for cluster in clusters:
            bbox = (float(cluster.x0), float(cluster.y0), float(cluster.x1), float(cluster.y1))
            width, height = bbox[2] - bbox[0], bbox[3] - bbox[1]
            if width < _MIN_FIGURE_SIDE * 1.5 or height < _MIN_FIGURE_SIDE * 1.5:
                continue
            if (width * height) / page_area < _MIN_FIGURE_AREA * 3:
                continue
            # A cluster of one or two paths is a rule, a box or an underline.
            # A chart is made of dozens.
            paths = sum(
                1 for d in drawings
                if _overlap(tuple(d["rect"]), bbox) > 0.9  # type: ignore[arg-type]
            )
            if paths < 6:
                continue
            if any(_overlap(bbox, other) > 0.5 for other, _, _ in out):
                continue
            out.append((bbox, "drawing", {"paths": paths}))

    return out


def find_figures(
    page: PageContent, include_drawings: bool = True, tables: Optional[List[Table]] = None
) -> List[Figure]:
    """Images and chart-shaped vector clusters, each with its caption.

    A figure's own text — axis labels, the numbers inside a diagram — is left
    on the page rather than swallowed. It is usually meaningless out of
    context, but it is content, and this pipeline does not delete content it
    merely suspects.
    """
    tables = tables or []
    figures: List[Figure] = []

    for bbox, kind, extra in _figure_candidates(page, include_drawings):
        if any(_overlap(bbox, table.bbox) > 0.6 for table in tables):
            continue
        caption, anchor = _caption_for(page, bbox)
        if anchor is None:
            anchor = _position_for(page, bbox)
        figures.append(
            Figure(
                page=page.number,
                bbox=bbox,
                kind=kind,
                caption=caption,
                anchor=anchor,
                xref=int(extra.get("xref", 0)),
                width=int(extra.get("width", 0)),
                height=int(extra.get("height", 0)),
            )
        )

    return figures


def _caption_for(page: PageContent, bbox: BBox) -> Tuple[str, Optional[int]]:
    """The caption line under (or over) a figure, removed from the flow.

    Only a line that *announces* itself as a caption is taken — "איור 3: …",
    "Figure 2 — …". Guessing from proximity alone would eat the first line of
    the paragraph that follows a full-width image, which is a real sentence
    from the document.
    """
    near = max((bbox[3] - bbox[1]) * 0.25, 60.0)
    for line in list(page.lines):
        below = 0 <= line.top - bbox[3] <= near
        above = 0 <= bbox[1] - line.bottom <= near
        if not (below or above):
            continue
        if _overlap(line.bbox, (bbox[0] - 40, bbox[1] - near, bbox[2] + 40, bbox[3] + near)) < 0.5:
            continue
        if not looks_like_caption(line.text):
            continue
        anchor = line.order
        page.lines = [other for other in page.lines if other is not line]
        return line.text, anchor
    return "", None


def attach_captions_to_tables(page: PageContent, tables: List[Table]) -> None:
    """Give each table the caption line sitting against it, if there is one."""
    for table in tables:
        caption, anchor = _caption_for(page, table.bbox)
        if caption:
            table.caption = caption
            table.anchor = min(table.anchor, anchor if anchor is not None else table.anchor)


def harvest(
    pages: List[PageContent],
    direction: str = "ltr",
    tables: bool = True,
    figures: bool = True,
    drawings: bool = True,
) -> None:
    """Run the object stages over every page, in place.

    Order matters: tables first, so a figure detector cannot claim a ruled
    grid, and captions last, so a caption is only removed once and by whoever
    it belongs to.
    """
    for page in pages:
        found_tables = find_tables(page, direction) if tables else []
        if found_tables:
            attach_captions_to_tables(page, found_tables)
        page.tables = found_tables
        page.figures = find_figures(page, drawings, found_tables) if figures else []


def extract_assets(doc, pages: List[PageContent], directory: str, prefix: str = "") -> int:
    """Write every figure to disk and record the path on it.

    Images come out in whatever format the PDF stored them; vector figures are
    rendered at 200 dpi, because there is no stored file to lift. The point is
    that a multimodal model can be handed the picture later — the Markdown
    references these paths, and nothing else in the pipeline depends on them.
    """
    os.makedirs(directory, exist_ok=True)
    folder = os.path.basename(directory.rstrip("/\\")) or "assets"
    written = 0

    for index, page in enumerate(pages):
        raw = raw_page(page)
        for order, figure in enumerate(page.figures):
            name = f"{prefix}{figure.id or f'p{page.number}-{order + 1}'}"
            try:
                if figure.kind == "image" and figure.xref:
                    data = doc.extract_image(figure.xref)
                    filename = f"{name}.{data.get('ext', 'png')}"
                    with open(os.path.join(directory, filename), "wb") as handle:
                        handle.write(data["image"])
                elif raw is not None:
                    filename = f"{name}.png"
                    raw.get_pixmap(dpi=200, clip=tuple(figure.bbox)).save(
                        os.path.join(directory, filename)
                    )
                else:
                    continue
            except (RuntimeError, ValueError, TypeError, OSError, KeyError):
                continue
            # Relative to the Markdown file, which sits beside the assets folder.
            figure.asset = f"{folder}/{filename}"
            written += 1

    return written
