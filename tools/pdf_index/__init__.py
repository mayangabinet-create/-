"""Turn a long PDF into an index plus the passages worth sending to Claude.

The app reads an upload in the browser and condenses it into a digest for
the planning call — an outline plus passages sampled across the document.
That answers "what is this book about". It does not answer "what does page
43 say", because a digest has no pages in it.

This package is the offline half, and page numbers are the point of it:

    PDF -> page text -> cleaning -> heading/chapter detection -> index
        -> the chapters a question actually needs -> Claude

Every stage after extraction is a pure function over a list of pages, so the
detection and indexing logic is testable without a PDF reader installed.
"""

from .extract import Page, extract_pages, available_backends
from .clean import clean_pages
from .structure import Heading, find_headings, detect_language
from .index import Chapter, build_index, render_index
from .retrieve import select_relevant, render_relevant

__all__ = [
    "Page",
    "extract_pages",
    "available_backends",
    "clean_pages",
    "Heading",
    "find_headings",
    "detect_language",
    "Chapter",
    "build_index",
    "render_index",
    "select_relevant",
    "render_relevant",
]
