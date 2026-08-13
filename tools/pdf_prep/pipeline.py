"""The pipeline itself — the stages in order, and the order is the point.

    PDF
     ↓  read.py      pages, with font sizes, boxes, images; OCR where needed
     ↓  order.py     columns found, lines put in reading order
     ↓  objects.py   tables and figures lifted out, keeping their place
     ↓  tidy.py      running headers, page numbers, hyphens, direction
     ↓  blocks.py    headings, lists, formulas, footnotes; lines joined to prose
     ↓  chunk.py     outline with page ranges, chunks sized for one call
     ↓  emit.py      document.md  +  document.json

Each stage is a function over plain data, so any of them can be run alone in a
test, and a document can be inspected between two of them. `prepare()` is just
the sequence written out; there is no logic here that is not ordering.
"""

from __future__ import annotations

import os
from typing import Callable, List, Optional

from .blocks import build_blocks, document_title
from .chunk import attach_terms, build_chunks, build_sections
from .emit import write_outputs
from .model import Document
from .objects import extract_assets, harvest
from .order import document_direction, sort_pages
from .read import (
    ReadError,
    detach_raw_pages,
    open_pdf,
    read_pages,
    read_pages_without_geometry,
)
from .tidy import repair_direction, tidy_pages

Progress = Optional[Callable[[str], None]]


def _assign_ids(document: Document) -> None:
    """Stable ids for everything the JSON refers to.

    Sequential and zero-padded so that ids sort the way the document reads,
    which matters when a model is asked to work through the chunks in order.
    """
    tables = figures = 0
    for index, block in enumerate(document.blocks, start=1):
        block.id = f"b{index:04d}"
        if block.kind == "table" and block.table is not None:
            tables += 1
            block.table.id = f"t{tables:03d}"
        elif block.kind == "figure" and block.figure is not None:
            figures += 1
            # A figure was named earlier, when its file was written; keeping
            # that name is what makes assets/f003.png the figure called f003.
            block.figure.id = block.figure.id or f"f{figures:03d}"


def prepare(
    path: str,
    output_dir: Optional[str] = None,
    ocr: str = "auto",
    ocr_language: str = "heb+eng",
    ocr_dpi: int = 300,
    first_page: int = 1,
    last_page: Optional[int] = None,
    tables: bool = True,
    figures: bool = True,
    drawings: bool = True,
    assets: bool = True,
    page_markers: bool = True,
    full_block_index: bool = False,
    bundle: bool = False,
    chunk_chars: int = 4000,
    header_threshold: float = 0.35,
    on_progress: Progress = None,
) -> Document:
    """Read one PDF and build the document. Writes the files if given a directory.

    Returns the `Document` either way, so a caller that wants the structure in
    memory — a server answering a request, a test — does not have to write two
    files and read them back.
    """
    def say(message: str) -> None:
        if on_progress:
            on_progress(message)

    warnings: List[str] = []
    assets_dir = os.path.join(output_dir, "assets") if output_dir and assets else ""

    try:
        with open_pdf(path) as doc:
            say("reading")
            pages, info = read_pages(
                doc,
                ocr=ocr,
                ocr_language=ocr_language,
                ocr_dpi=ocr_dpi,
                first_page=first_page,
                last_page=last_page,
                on_progress=lambda n, total, what: say(
                    f"{what} page {n}/{total}" if what == "ocr" else f"reading page {n}/{total}"
                ),
            )

            direction, language = document_direction(pages)
            # Before anything reads the text: on a visually ordered document
            # there is no text to read until the lines are flipped.
            flipped = repair_direction(pages)

            say("ordering")
            sort_pages(pages, direction)

            if tables or figures:
                # After the direction repair, deliberately: a table's cells are
                # re-read from the spans this pipeline has already fixed, so
                # they need no repair of their own.
                say("tables and figures")
                harvest(
                    pages,
                    direction=direction,
                    tables=tables,
                    figures=figures,
                    drawings=drawings,
                )

            document = Document(
                path=path,
                title="",
                language=language,
                direction=direction,
                page_count=info.get("pdf", {}).get("page_count", len(pages)),
                pages=pages,
            )
            _assign_figure_ids(pages)

            if assets_dir:
                say("extracting images")
                extract_assets(doc, pages, assets_dir)

            detach_raw_pages(pages)
    except ReadError as error:
        if "PyMuPDF is not installed" not in str(error):
            raise
        # Every geometric signal is gone on this path; say so once, here, and
        # let the textual rules carry the document.
        say("PyMuPDF missing — falling back to text-only extraction")
        pages, info = read_pages_without_geometry(path, first_page, last_page)
        direction, language = document_direction(pages)
        flipped = repair_direction(pages)
        sort_pages(pages, direction)
        document = Document(
            path=path,
            title="",
            language=language,
            direction=direction,
            page_count=len(pages),
            pages=pages,
        )
        warnings.append(
            "PyMuPDF was not available: no font sizes, tables or figures were "
            "read, and headings were detected from wording alone."
        )

    say("cleaning")
    cleaning = tidy_pages(pages, fix_direction=False, header_threshold=header_threshold)
    cleaning["direction_repaired"] = flipped

    say("structure")
    blocks, block_stats = build_blocks(pages, hebrew=(language == "he"))
    document.blocks = blocks
    _assign_ids(document)

    document.title = document_title(
        blocks,
        meta_title=info.get("pdf", {}).get("title", ""),
        fallback=os.path.splitext(os.path.basename(path))[0],
    )

    say("chunking")
    document.sections = build_sections(blocks, last_page=pages[-1].number if pages else 0)
    document.chunks = build_chunks(blocks, target_chars=chunk_chars)

    by_id = {block.id: block for block in blocks}
    texts = [
        "\n".join(
            _block_text(by_id[bid]) for bid in chunk.block_ids if bid in by_id
        )
        for chunk in document.chunks
    ]
    attach_terms(document.chunks, texts)

    ocr_pages = info.get("ocr", {}).get("pages", [])
    if ocr_pages:
        warnings.append(
            f"{len(ocr_pages)} page(s) had no text layer and were read by OCR; "
            "their text is a recognition, not a copy."
        )
    if not ocr_pages:
        empty = [page.number for page in pages if not page.lines]
        if len(empty) > len(pages) * 0.3:
            reason = (
                "OCR was turned off"
                if ocr == "never"
                else "tesseract is not installed"
            )
            warnings.append(
                f"{len(empty)} of {len(pages)} pages have no text at all and "
                f"{reason} — this is probably a scan, and reading it needs OCR."
            )
    missing = info.get("ocr", {}).get("missing_languages", [])
    if missing:
        warnings.append(
            "OCR language pack(s) not installed: " + ", ".join(missing)
        )

    document.warnings = warnings
    document.meta = {
        "pdf": info.get("pdf", {}),
        "extraction": {
            "backend": info.get("backend", ""),
            "ocr_mode": ocr,
            "ocr_pages": ocr_pages,
            "ocr_language": info.get("ocr", {}).get("language", ""),
            "pdf_outline_entries": len(info.get("toc", [])),
            **{k: v for k, v in block_stats.items() if k != "blocks"},
        },
        "cleaning": cleaning,
    }

    if output_dir:
        say("writing")
        write_outputs(
            document,
            output_dir,
            page_markers=page_markers,
            full_block_index=full_block_index,
            bundle=bundle,
        )

    return document


def _assign_figure_ids(pages) -> None:
    """Name the figures before the assets are written, so files match ids."""
    count = 0
    for page in pages:
        for figure in page.figures:
            count += 1
            figure.id = f"f{count:03d}"


def _block_text(block) -> str:
    if block.items:
        return "\n".join(block.items)
    if block.table is not None:
        return "\n".join(" ".join(row) for row in block.table.rows)
    return block.text
