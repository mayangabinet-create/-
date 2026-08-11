"""Turn a long PDF into an index plus the passages worth sending to Claude.

The browser reads the first 20 pages of an upload and sends the model 5,000
characters of it. That is fine for a handout and wrong for a 300-page book:
the model sees chapter 1 and nothing else, and quizzes on chapter 1 forever.

This package does the offline half of the job:

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
