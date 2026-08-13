"""Stage 7 — write the two files.

`document.md` is the text, and it is the only copy of the text. `document.json`
is a map of it: every section, chunk, table and figure records the character
range of `document.md` it occupies. Nothing is stored twice, so nothing can
disagree with itself after an edit, and a reader that wants one chapter can
seek to it instead of parsing the whole file.

The Markdown is written for a model first and a person second, which mostly
means the same thing — headings that nest properly, tables that are tables,
paragraphs that are paragraphs — with one addition: page markers, written as
HTML comments. They render as nothing, and they let a model that has read only
the Markdown say which page an answer came from.
"""

from __future__ import annotations

import datetime as _datetime
import hashlib
import json
import os
import re
from typing import Dict, List, Sequence

from .model import Block, Document, Section

SCHEMA = "pdf-prep/1"


class _Writer:
    """Accumulates the Markdown and remembers where everything landed."""

    def __init__(self) -> None:
        self.parts: List[str] = []
        self.length = 0

    def write(self, text: str) -> None:
        if not text:
            return
        self.parts.append(text)
        self.length += len(text)

    def paragraph(self, text: str) -> None:
        """Write a block and the blank line after it, and nothing extra."""
        self.write(text.rstrip() + "\n\n")

    @property
    def text(self) -> str:
        return "".join(self.parts)


def _escape_cell(value: str) -> str:
    """A pipe inside a cell would end the column; a newline would end the row."""
    return value.replace("|", "\\|").replace("\n", " ").strip()


def _table_markdown(block: Block) -> str:
    table = block.table
    assert table is not None
    rows = [list(row) for row in table.rows]
    header = list(table.header)

    # GFM has no table without a header row. A table that does not declare one
    # is far more often a grid whose first row *is* the header than a grid with
    # no header at all, so the first row is promoted rather than a blank row
    # invented.
    if not header:
        header, rows = rows[0], rows[1:]

    width = max([len(header)] + [len(row) for row in rows])
    header += [""] * (width - len(header))

    lines = [
        "| " + " | ".join(_escape_cell(cell) for cell in header) + " |",
        "|" + "|".join([" --- "] * width) + "|",
    ]
    for row in rows:
        padded = list(row) + [""] * (width - len(row))
        lines.append("| " + " | ".join(_escape_cell(cell) for cell in padded) + " |")
    return "\n".join(lines)


def _figure_markdown(block: Block) -> str:
    figure = block.figure
    assert figure is not None
    caption = (figure.caption or block.text or "").strip()
    label = caption or ("תרשים" if figure.kind == "drawing" else "תמונה")

    if figure.asset:
        line = f"![{label}]({figure.asset})"
    else:
        # No file was extracted, but the document still contains a picture
        # here, and a model reading the text is entitled to know that.
        line = f"**[{label}]**"
    note = f"<!-- figure: {figure.id} | page {figure.page} | {figure.kind} -->"
    return f"{line}\n{note}"


def _list_markdown(block: Block) -> str:
    lines = []
    for index, item in enumerate(block.items, start=1):
        bullet = f"{index}." if block.ordered else "-"
        lines.append(f"{bullet} {item.strip()}")
    return "\n".join(lines)


def _front_matter(document: Document) -> str:
    """A short YAML header, so the Markdown says what it is on its own."""
    fields = [
        ("title", document.title),
        ("source", os.path.basename(document.path)),
        ("pages", str(document.page_count)),
        ("language", document.language),
        ("generated_by", "tools/pdf_prep"),
    ]
    lines = ["---"]
    for key, value in fields:
        text = str(value).replace('"', "'")
        lines.append(f'{key}: "{text}"')
    lines.append("---")
    return "\n".join(lines) + "\n\n"


def render_markdown(document: Document, page_markers: bool = True) -> str:
    """Render the document, recording each block's character range as it goes."""
    writer = _Writer()
    writer.write(_front_matter(document))
    title_start = writer.length
    writer.paragraph(f"# {document.title.strip()}")
    title_end = writer.length

    footnotes: List[Block] = []
    current_page = 0
    title_taken = False

    for block in document.blocks:
        if page_markers and block.page and block.page != current_page:
            current_page = block.page
            writer.write(f"<!-- page {current_page} -->\n\n")

        # The heading on the title page is the title, and writing it twice —
        # once as the document's H1, once as its own first section — makes the
        # outline claim a chapter that is really a cover.
        if (
            not title_taken
            and block.kind == "heading"
            and block.text.strip().lower() == document.title.strip().lower()
        ):
            title_taken = True
            block.md_start, block.md_end = title_start, title_end
            continue

        block.md_start = writer.length

        if block.kind == "heading":
            hashes = "#" * min(block.level + 1, 6)
            writer.paragraph(f"{hashes} {block.text.strip()}")
        elif block.kind == "list":
            writer.paragraph(_list_markdown(block))
        elif block.kind == "table":
            if block.table is not None and block.table.caption:
                writer.paragraph(f"**{block.table.caption.strip()}**")
            writer.paragraph(_table_markdown(block))
        elif block.kind == "figure":
            writer.paragraph(_figure_markdown(block))
        elif block.kind == "formula":
            writer.paragraph(f"$$\n{block.text.strip()}\n$$")
        elif block.kind == "caption":
            writer.paragraph(f"*{block.text.strip()}*")
        elif block.kind == "footnote":
            # Held back and written where the reader expects them: at the end
            # of the document, as Markdown footnote definitions.
            footnotes.append(block)
            block.md_start = writer.length
            block.md_end = writer.length
            continue
        else:
            writer.paragraph(block.text.strip())

        block.md_end = writer.length

    if footnotes:
        writer.paragraph("---")
        writer.paragraph("## הערות שוליים" if document.language == "he" else "## Notes")
        for block in footnotes:
            block.md_start = writer.length
            marker = block.marker or "*"
            writer.write(f"[^{block.page}-{marker}]: {block.text.strip()}\n")
            block.md_end = writer.length
        writer.write("\n")

    return writer.text


# -------------------------------------------------------------------- JSON ---


def _section_json(section: Section, counter: List[int]) -> Dict:
    counter[0] += 1
    section.id = f"s{counter[0]:03d}"
    return {
        "id": section.id,
        "title": section.title,
        "level": section.level,
        "page_start": section.page_start,
        "page_end": section.page_end,
        "path": section.path,
        "children": [_section_json(child, counter) for child in section.children],
    }


def _block_json(block: Block) -> Dict:
    entry: Dict[str, object] = {
        "id": block.id,
        "kind": block.kind,
        "pages": block.pages,
        "chars": block.char_count,
        "md_start": block.md_start,
        "md_end": block.md_end,
    }
    if block.kind == "heading":
        entry["level"] = block.level
        entry["text"] = block.text
    if block.kind in ("figure", "table"):
        entry["ref"] = (block.figure or block.table).id  # type: ignore[union-attr]
    if block.kind == "footnote":
        entry["marker"] = block.marker
    if block.kind == "list":
        entry["items"] = len(block.items)
        entry["ordered"] = block.ordered
    return entry


def _contiguous(blocks: Sequence[Block]) -> List[Block]:
    """The blocks whose character range says where a chunk or page *is*.

    Footnotes are written at the end of the document rather than where they
    were found, so a chunk that contains one would otherwise claim a range
    running to the last line of the file — and two chunks that claim
    overlapping ranges are worse than no ranges at all.
    """
    spans = [b for b in blocks if b.md_end > b.md_start and b.kind != "footnote"]
    if spans:
        return spans
    return [b for b in blocks if b.md_end > b.md_start]


def _file_facts(path: str) -> Dict:
    try:
        with open(path, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        size = os.path.getsize(path)
    except OSError:
        digest, size = "", 0
    return {"name": os.path.basename(path), "bytes": size, "sha256": digest}


# The blocks worth naming one by one. A paragraph is addressable through the
# chunk that contains it; a table, a figure or a heading is something a caller
# asks for by name.
_STRUCTURAL = ("heading", "table", "figure", "formula", "footnote")


def build_manifest(
    document: Document, markdown: str, full_block_index: bool = False
) -> Dict:
    """The structure file: everything about the document except its text.

    Character ranges point into `document.md` as written — 0-based, end
    exclusive, counted in Unicode characters. A consumer slices the Markdown
    with them; it does not have to parse it.

    `blocks` lists the structural blocks only unless `full_block_index` is
    set. Listing every paragraph as well doubles the size of this file for
    something the chunk ranges already address, and the point of keeping the
    text out of here is that the whole map fits in a prompt. Which of the two
    is in the file is recorded in `document.block_index`, so a consumer never
    has to guess whether an id is missing or merely not indexed.
    """
    counter = [0]
    outline = [_section_json(section, counter) for section in document.sections]

    tables = [
        {
            "id": block.table.id,
            "page": block.table.page,
            "caption": block.table.caption,
            "rows": block.table.n_rows,
            "columns": block.table.n_cols,
            "header": block.table.header,
            "data": block.table.rows,
            "md_start": block.md_start,
            "md_end": block.md_end,
        }
        for block in document.blocks
        if block.kind == "table" and block.table is not None
    ]

    figures = [
        {
            "id": block.figure.id,
            "page": block.figure.page,
            "kind": block.figure.kind,
            "caption": block.figure.caption,
            "asset": block.figure.asset,
            "bbox": [round(v, 1) for v in block.figure.bbox],
            "pixels": [block.figure.width, block.figure.height],
            "md_start": block.md_start,
            "md_end": block.md_end,
        }
        for block in document.blocks
        if block.kind == "figure" and block.figure is not None
    ]

    footnotes = [
        {
            "id": block.id,
            "page": block.page,
            "marker": block.marker,
            "text": block.text,
            "md_start": block.md_start,
            "md_end": block.md_end,
        }
        for block in document.blocks
        if block.kind == "footnote"
    ]

    formulas = [
        {
            "id": block.id,
            "page": block.page,
            "text": block.text,
            "md_start": block.md_start,
            "md_end": block.md_end,
        }
        for block in document.blocks
        if block.kind == "formula"
    ]

    by_id = {block.id: block for block in document.blocks}
    chunks = []
    for chunk in document.chunks:
        blocks = [by_id[bid] for bid in chunk.block_ids if bid in by_id]
        spans = _contiguous(blocks)
        chunk.md_start = min((b.md_start for b in spans), default=0)
        chunk.md_end = max((b.md_end for b in spans), default=0)
        chunks.append(
            {
                "id": chunk.id,
                "heading_path": chunk.heading_path,
                "level": chunk.level,
                "part": chunk.part,
                "parts": chunk.parts,
                "page_start": chunk.page_start,
                "page_end": chunk.page_end,
                "chars": chunk.chars,
                "terms": chunk.terms,
                # `heading_path` says where the chunk starts. A chunk that
                # swallowed a short section or two also contains their
                # headings, and a reader choosing chunks needs to see them.
                "headings": [b.text for b in blocks if b.kind == "heading"],
                "blocks": chunk.block_ids,
                "tables": [
                    b.table.id for b in blocks if b.kind == "table" and b.table
                ],
                "figures": [
                    b.figure.id for b in blocks if b.kind == "figure" and b.figure
                ],
                "md_start": chunk.md_start,
                "md_end": chunk.md_end,
            }
        )

    pages = []
    for page in document.pages:
        blocks = [b for b in document.blocks if page.number in b.pages]
        spans = _contiguous(blocks)
        pages.append(
            {
                "number": page.number,
                "source": page.source,
                "is_contents": page.is_toc,
                "chars": sum(b.char_count for b in blocks if b.page == page.number),
                "blocks": len(blocks),
                "md_start": min((b.md_start for b in spans), default=0),
                "md_end": max((b.md_end for b in spans), default=0),
            }
        )

    words = len(re.findall(r"\S+", markdown))
    return {
        "schema": SCHEMA,
        "generated_at": _datetime.datetime.now(_datetime.timezone.utc)
        .replace(microsecond=0)
        .isoformat(),
        "source": {**_file_facts(document.path), **document.meta.get("pdf", {})},
        "document": {
            "title": document.title,
            "language": document.language,
            "direction": document.direction,
            "page_count": document.page_count,
            "chars": len(markdown),
            "words": words,
            "markdown": "document.md",
            "block_index": "full" if full_block_index else "structural",
        },
        "extraction": document.meta.get("extraction", {}),
        "cleaning": document.meta.get("cleaning", {}),
        "counts": {
            "blocks": len(document.blocks),
            "headings": len(document.of_kind("heading")),
            "paragraphs": len(document.of_kind("paragraph")),
            "lists": len(document.of_kind("list")),
            "tables": len(tables),
            "figures": len(figures),
            "formulas": len(formulas),
            "footnotes": len(footnotes),
            "chunks": len(chunks),
        },
        "outline": outline,
        "chunks": chunks,
        "tables": tables,
        "figures": figures,
        "formulas": formulas,
        "footnotes": footnotes,
        "pages": pages,
        "blocks": [
            _block_json(block)
            for block in document.blocks
            if full_block_index or block.kind in _STRUCTURAL
        ],
        "warnings": document.warnings,
    }


def build_bundle(
    document: Document,
    page_markers: bool = True,
    full_block_index: bool = False,
) -> Dict:
    """Both outputs as one object, for handing to something that takes a file.

    The two-file split is right on disk, where a person reads the Markdown and
    a program reads the JSON. It is wrong at an upload box, which takes one
    file — and a user who picks only one of the two has either text with no
    structure or structure pointing at text that is not there.

    Nothing is duplicated by joining them: the Markdown appears once, and the
    manifest's character ranges index into it exactly as they do on disk.
    """
    markdown = render_markdown(document, page_markers=page_markers)
    return {
        "schema": SCHEMA,
        "kind": "bundle",
        "markdown": markdown,
        "manifest": build_manifest(document, markdown, full_block_index=full_block_index),
    }


def write_outputs(
    document: Document,
    directory: str,
    page_markers: bool = True,
    full_block_index: bool = False,
    bundle: bool = False,
    markdown_name: str = "document.md",
    json_name: str = "document.json",
    bundle_name: str = "document.bundle.json",
) -> Dict[str, str]:
    """Render, index and write the outputs. Returns the paths written."""
    os.makedirs(directory, exist_ok=True)

    markdown = render_markdown(document, page_markers=page_markers)
    manifest = build_manifest(document, markdown, full_block_index=full_block_index)

    md_path = os.path.join(directory, markdown_name)
    json_path = os.path.join(directory, json_name)
    with open(md_path, "w", encoding="utf-8") as handle:
        handle.write(markdown)
    with open(json_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    written = {"markdown": md_path, "json": json_path}
    if bundle:
        # Rendered once and reused: the bundle has to hold the same bytes the
        # Markdown file does, or the manifest's offsets point into the wrong
        # copy of the document.
        bundle_path = os.path.join(directory, bundle_name)
        with open(bundle_path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "schema": SCHEMA,
                    "kind": "bundle",
                    "markdown": markdown,
                    "manifest": manifest,
                },
                handle,
                ensure_ascii=False,
            )
            handle.write("\n")
        written["bundle"] = bundle_path

    return written
