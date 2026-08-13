"""Command line: one PDF in, two files out.

    python3 -m tools.pdf_prep book.pdf -o out/

Everything the pipeline can be told is a flag here, but the defaults are the
answer for almost every document: read it, OCR the pages that need it, keep
tables and figures, write `out/document.md` and `out/document.json`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import List, Optional

from .emit import build_manifest, render_markdown
from .model import Document
from .pipeline import prepare


def _parse_pages(value: str) -> tuple:
    """"12", "3-40", "10-" — the page range to read."""
    value = (value or "").strip()
    if not value:
        return 1, None
    if "-" not in value:
        page = int(value)
        return page, page
    first, _, last = value.partition("-")
    return int(first or 1), (int(last) if last.strip() else None)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m tools.pdf_prep",
        description="Turn a PDF into document.md + document.json for an AI to read.",
    )
    parser.add_argument("pdf", help="the file to read")
    parser.add_argument(
        "-o", "--out", default="",
        help="directory for document.md, document.json and assets/ "
             "(default: <pdf name>.prepared next to the PDF)",
    )
    parser.add_argument(
        "--pages", default="", metavar="RANGE",
        help="only these pages: 12, 3-40, 10-",
    )
    parser.add_argument(
        "--ocr", choices=("auto", "never", "always"), default="auto",
        help="auto reads a page with OCR only when it has no text layer",
    )
    parser.add_argument(
        "--ocr-lang", default="heb+eng", metavar="LANGS",
        help="tesseract languages, joined by + (default: heb+eng)",
    )
    parser.add_argument("--ocr-dpi", type=int, default=300)
    parser.add_argument(
        "--chunk-chars", type=int, default=4000, metavar="N",
        help="target size of a chunk, in characters (default: 4000)",
    )
    parser.add_argument(
        "--header-threshold", type=float, default=0.35, metavar="SHARE",
        help="a line repeated in the margins of this share of pages is "
             "furniture and is dropped (default: 0.35)",
    )
    parser.add_argument("--no-tables", action="store_true", help="skip table detection")
    parser.add_argument("--no-figures", action="store_true", help="skip images and charts")
    parser.add_argument(
        "--no-drawings", action="store_true",
        help="keep embedded images but ignore vector charts",
    )
    parser.add_argument(
        "--no-assets", action="store_true",
        help="do not write the figures to assets/ (they stay listed in the JSON)",
    )
    parser.add_argument(
        "--no-page-markers", action="store_true",
        help="omit the <!-- page N --> comments from the Markdown",
    )
    parser.add_argument(
        "--block-index", action="store_true",
        help="index every paragraph in the JSON, not only the structural blocks "
             "(roughly doubles its size)",
    )
    parser.add_argument(
        "--bundle", action="store_true",
        help="also write document.bundle.json — the Markdown and the manifest in "
             "one file, which is what the app's upload box takes",
    )
    parser.add_argument(
        "--stdout", choices=("md", "json"), default="",
        help="also print one of the outputs, for piping",
    )
    parser.add_argument("-q", "--quiet", action="store_true")
    return parser


def _summary(document: Document, out_dir: str, written=("document.md", "document.json")) -> str:
    counts = {
        kind: len(document.of_kind(kind))
        for kind in ("heading", "paragraph", "list", "table", "figure", "formula", "footnote")
    }
    lines = [
        f"{document.title}",
        f"  {document.page_count} pages · {document.language}/{document.direction} · "
        f"{len(document.chunks)} chunks",
        "  " + " · ".join(f"{name}s {n}" for name, n in counts.items() if n),
    ]

    cleaning = document.meta.get("cleaning", {})
    dropped = [
        f"{cleaning.get('headers', 0)} running headers",
        f"{cleaning.get('page_numbers', 0)} page numbers",
        f"{cleaning.get('contents_pages', 0)} contents pages",
    ]
    lines.append("  removed: " + ", ".join(dropped))

    ocr_pages = document.meta.get("extraction", {}).get("ocr_pages", [])
    if ocr_pages:
        shown = ", ".join(str(p) for p in ocr_pages[:8])
        more = f" (+{len(ocr_pages) - 8})" if len(ocr_pages) > 8 else ""
        lines.append(f"  OCR: pages {shown}{more}")

    for warning in document.warnings:
        lines.append(f"  ! {warning}")

    if out_dir:
        for name in written:
            lines.append(f"  → {os.path.join(out_dir, name)}")
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    first_page, last_page = _parse_pages(args.pages)
    out_dir = args.out or os.path.splitext(args.pdf)[0] + ".prepared"

    def progress(message: str) -> None:
        if not args.quiet:
            print(f"\r\033[K{message}", end="", file=sys.stderr, flush=True)

    try:
        document = prepare(
            args.pdf,
            output_dir=out_dir,
            ocr=args.ocr,
            ocr_language=args.ocr_lang,
            ocr_dpi=args.ocr_dpi,
            first_page=first_page,
            last_page=last_page,
            tables=not args.no_tables,
            figures=not args.no_figures,
            drawings=not args.no_drawings,
            assets=not args.no_assets,
            page_markers=not args.no_page_markers,
            full_block_index=args.block_index,
            bundle=args.bundle,
            chunk_chars=args.chunk_chars,
            header_threshold=args.header_threshold,
            on_progress=progress,
        )
    except FileNotFoundError:
        print(f"No such file: {args.pdf}", file=sys.stderr)
        return 2
    except (RuntimeError, ValueError) as error:
        print(f"\n{error}", file=sys.stderr)
        return 1

    if not args.quiet:
        print("\r\033[K", end="", file=sys.stderr)
        written = ["document.md", "document.json"]
        if args.bundle:
            written.append("document.bundle.json")
        print(_summary(document, out_dir, written), file=sys.stderr)

    if args.stdout == "md":
        # Re-rendered rather than read back: identical bytes, one less thing
        # that can be stale.
        print(render_markdown(document, page_markers=not args.no_page_markers))
    elif args.stdout == "json":
        markdown = render_markdown(document, page_markers=not args.no_page_markers)
        print(json.dumps(
            build_manifest(document, markdown, full_block_index=args.block_index),
            ensure_ascii=False,
            indent=2,
        ))

    return 0
