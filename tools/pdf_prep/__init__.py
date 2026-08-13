"""`pdf_prep` — a PDF, prepared for a model to read.

    from tools.pdf_prep import prepare

    document = prepare("book.pdf", output_dir="out/")
    print(document.title, len(document.chunks))

The pipeline is deterministic and offline: PyMuPDF for the reading, tesseract
for pages that were scanned, and rules for everything after that. No model is
called anywhere in it, which is the point — the output is what the document
says, not what a model thought it said, and running it twice gives the same
answer twice.

`tools/pdf_index` next door answers "which chapter, which page" over a large
book. This answers "give me the whole document, clean". They share the parts
that are the same problem: reading direction, running headers, and what a
Hebrew chapter heading looks like.
"""

from .model import Block, Chunk, Document, Figure, Section, Table
from .pipeline import prepare
from .emit import build_manifest, render_markdown, write_outputs

__all__ = [
    "prepare",
    "render_markdown",
    "build_manifest",
    "write_outputs",
    "Document",
    "Block",
    "Chunk",
    "Section",
    "Table",
    "Figure",
]
