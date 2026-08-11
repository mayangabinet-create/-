"""The command line: PDF in, something worth sending to Claude out.

    python3 -m tools.pdf_index index  book.pdf
    python3 -m tools.pdf_index context book.pdf --query "מיסוי דירה שנייה"
    python3 -m tools.pdf_index context book.pdf --chapter 2 --budget 8000
    python3 -m tools.pdf_index text   book.pdf --pages 25-67
    python3 -m tools.pdf_index inspect book.pdf

`context` is the one that matters: it prints the index and, under it, only
the passages the question needs — a few thousand characters standing in for
three hundred pages.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from .clean import clean_pages, page_text
from .extract import ExtractionError, Page, available_backends, extract_pages
from .index import (
    build_index,
    find_chapter,
    flatten,
    render_index,
)
from .retrieve import coverage, render_relevant, select_relevant
from .structure import detect_language, find_headings


def _parse_pages(value: Optional[str]) -> tuple:
    """'25-67' -> (25, 67); '25-' -> (25, None); '25' -> (25, 25)."""
    if not value:
        return 1, None
    if "-" not in value:
        page = int(value)
        return page, page
    first, _, last = value.partition("-")
    return int(first or 1), (int(last) if last else None)


def load(args) -> List[Page]:
    first, last = _parse_pages(args.pages)
    pages = extract_pages(
        args.pdf, backend=args.backend, first_page=first, last_page=last
    )
    if not args.raw:
        clean_pages(pages, drop_toc=not args.keep_toc)
    return pages


def _analyse(args):
    pages = load(args)
    headings = find_headings(pages, loose=args.loose)
    chapters = build_index(pages, headings)
    language = args.language or detect_language(pages)
    return pages, chapters, language


def cmd_index(args) -> int:
    pages, chapters, language = _analyse(args)
    if args.json:
        print(json.dumps(
            {
                "language": language,
                "pages": len(pages),
                "first_page": pages[0].number if pages else 0,
                "last_page": pages[-1].number if pages else 0,
                "chapters": [c.to_dict() for c in chapters],
            },
            ensure_ascii=False,
            indent=2,
        ))
        return 0

    print(render_index(chapters, language, max_level=args.depth))
    if args.stats:
        total = sum(page.char_count for page in pages)
        print(
            f"\n{len(pages)} pages, {total:,} characters, "
            f"{len(flatten(chapters))} headings "
            f"({len([c for c in flatten(chapters) if c.level <= 2])} at depth 2)",
            file=sys.stderr,
        )
    return 0


def cmd_context(args) -> int:
    pages, chapters, language = _analyse(args)

    chapter = None
    if args.chapter:
        chapter = find_chapter(chapters, args.chapter)
        if chapter is None:
            print(f"No chapter matches {args.chapter!r}. Try: "
                  f"python3 -m tools.pdf_index index {args.pdf}", file=sys.stderr)
            return 2

    # No query and a chapter asked for by name means "give me that chapter",
    # so the passages come in reading order rather than by relevance.
    passages = select_relevant(
        chapters, args.query or "", budget=args.budget, chapter_filter=chapter
    )

    index_text = render_index(chapters, language, max_level=args.depth)
    relevant_text = render_relevant(passages, language)

    if args.json:
        print(json.dumps(
            {
                "language": language,
                "query": args.query or "",
                "chapter": chapter.label if chapter else None,
                "index": index_text,
                "relevant": relevant_text,
                "passages": [
                    {
                        "chapter": p.chapter.path_label,
                        "pages": [p.chapter.start_page, p.chapter.end_page],
                        "score": round(p.score, 3),
                        "text": p.text,
                    }
                    for p in passages
                ],
            },
            ensure_ascii=False,
            indent=2,
        ))
        return 0

    print(index_text)
    print()
    print(relevant_text)

    chars, touched = coverage(passages)
    total = sum(page.char_count for page in pages)
    share = (chars / total * 100) if total else 0
    print(
        f"\n{chars:,} characters from {touched} chapter(s) — "
        f"{share:.1f}% of the {total:,} characters in the document",
        file=sys.stderr,
    )
    return 0


def cmd_text(args) -> int:
    pages = load(args)
    print(page_text(pages))
    return 0


def cmd_inspect(args) -> int:
    """What the cleaner threw away, and what the detector thinks it found."""
    pages = load(args)
    headings = find_headings(pages, loose=args.loose)

    dropped = [(page.number, line) for page in pages for line in page.dropped]
    toc_pages = [page.number for page in pages if page.is_toc]

    print(f"readers available: {', '.join(available_backends()) or 'none'}")
    print(f"pages: {len(pages)}  language: {detect_language(pages)}")
    print(f"table-of-contents pages: {toc_pages or 'none found'}")
    print(f"lines dropped as boilerplate: {len(dropped)}")
    for number, line in dropped[:20]:
        print(f"  p{number}: {line}")
    if len(dropped) > 20:
        print(f"  ... and {len(dropped) - 20} more")

    print(f"\nheadings: {len(headings)}")
    for heading in headings[:40]:
        print(f"  p{heading.page:<4} L{heading.level} [{heading.kind}] {heading.label}")
    if len(headings) > 40:
        print(f"  ... and {len(headings) - 40} more")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m tools.pdf_index",
        description="Index a long PDF and pull out only the part a question needs.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p):
        p.add_argument("pdf", help="path to the PDF")
        p.add_argument("--pages", help="page range to read, e.g. 25-67")
        p.add_argument("--backend", choices=["pymupdf", "pdfplumber", "pypdf"],
                       help="force a particular PDF reader")
        p.add_argument("--raw", action="store_true",
                       help="skip cleaning (keep headers, footers, page numbers)")
        p.add_argument("--keep-toc", action="store_true",
                       help="keep table-of-contents pages in the text")
        p.add_argument("--loose", action="store_true", default=None,
                       help="also treat short standalone lines as headings")
        p.add_argument("--language", choices=["he", "en"],
                       help="override the detected language of the labels")
        p.add_argument("--depth", type=int, default=2,
                       help="deepest heading level to print (default 2)")
        return p

    index_parser = common(sub.add_parser("index", help="print the chapter index"))
    index_parser.add_argument("--json", action="store_true")
    index_parser.add_argument("--stats", action="store_true",
                              help="print page/character counts to stderr")
    index_parser.set_defaults(func=cmd_index)

    context_parser = common(
        sub.add_parser("context", help="print the index plus the relevant passages")
    )
    context_parser.add_argument("--query", help="what the model needs to answer")
    context_parser.add_argument("--chapter",
                                help="restrict to a chapter: a number, p42, or title text")
    context_parser.add_argument("--budget", type=int, default=12000,
                                help="character budget for the passages (default 12000)")
    context_parser.add_argument("--json", action="store_true")
    context_parser.set_defaults(func=cmd_context)

    text_parser = common(sub.add_parser("text", help="print the cleaned text"))
    text_parser.set_defaults(func=cmd_text)

    inspect_parser = common(
        sub.add_parser("inspect", help="show what cleaning and detection did")
    )
    inspect_parser.set_defaults(func=cmd_inspect)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ExtractionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except FileNotFoundError:
        print(f"error: no such file: {args.pdf}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
