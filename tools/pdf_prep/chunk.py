"""Stage 6 — the outline, and the document cut into pieces one call can hold.

Two products from one walk over the blocks.

The **outline** is the heading tree with real page ranges: what a reader would
find in a table of contents, except derived from the body rather than from a
contents page that may be out of date.

The **chunks** are the unit of work for whatever reads this next. A chunk
starts at a heading and ends before the next one of the same rank, unless it
grew too large, in which case it is split at a block boundary — never inside a
paragraph, never inside a table. Every chunk carries the path of headings above
it, so a passage handed to a model on its own still knows what it is part of.

Each chunk also carries its own top terms, scored by TF-IDF over the document.
They exist so that a model given the JSON alone can choose which chunks to
read, instead of being handed a 300-page document and asked to guess.
"""

from __future__ import annotations

import math
from typing import Dict, List, Sequence, Tuple

from ..pdf_index.retrieve import tokenize
from .model import Block, Chunk, Section

TARGET_CHARS = 4000       # a comfortable slice for one call, with room around it
MIN_CHARS = 400           # below this, a section is merged into its neighbour
TOP_TERMS = 8


# ----------------------------------------------------------------- outline ---


def build_sections(blocks: Sequence[Block], last_page: int = 0) -> List[Section]:
    """The heading tree, each node knowing the pages it covers.

    A section's page range runs to the start of the next heading at its own
    level or higher — a sub-section on page 30 does not end the chapter that
    contains it. That is the range a reader looks up, and the one a citation
    has to agree with.
    """
    headings = [
        (index, block) for index, block in enumerate(blocks) if block.kind == "heading"
    ]
    if not headings:
        return []

    flat: List[Section] = []
    for position, (index, block) in enumerate(headings):
        closing = next(
            (other for _, other in headings[position + 1:] if other.level <= block.level),
            None,
        )
        if closing is None:
            end_page = max(
                (b.pages[-1] for b in blocks[index:] if b.pages), default=block.page
            )
            end_page = max(end_page, last_page or block.page)
        else:
            end_page = max(block.page, closing.page - 1)

        flat.append(
            Section(
                title=block.text.strip(),
                level=block.level or 1,
                page_start=block.page,
                page_end=end_page,
                block_index=index,
            )
        )

    return _nest(flat)


def _nest(flat: List[Section]) -> List[Section]:
    """Attach each section to the nearest shallower one before it."""
    roots: List[Section] = []
    stack: List[Section] = []
    for section in flat:
        while stack and stack[-1].level >= section.level:
            stack.pop()
        if stack:
            stack[-1].children.append(section)
            section.parent = stack[-1]
        else:
            roots.append(section)
        stack.append(section)
    return roots


def flatten(sections: Sequence[Section]) -> List[Section]:
    return [node for root in sections for node in root.walk()]


# ------------------------------------------------------------------ chunks ---


def _heading_path(stack: Sequence[Block]) -> List[str]:
    return [block.text.strip() for block in stack if block.text.strip()]


def build_chunks(
    blocks: Sequence[Block],
    target_chars: int = TARGET_CHARS,
    min_chars: int = MIN_CHARS,
) -> List[Chunk]:
    """Cut the block sequence into chunks, on headings first and size second."""
    chunks: List[Chunk] = []
    stack: List[Block] = []
    current: List[Block] = []
    current_path: List[str] = []
    current_level = 1

    def flush() -> None:
        nonlocal current
        if not current:
            return
        chars = sum(block.char_count for block in current)
        pages = [page for block in current for page in block.pages]
        chunks.append(
            Chunk(
                id="",
                heading_path=list(current_path),
                level=current_level,
                page_start=min(pages) if pages else 0,
                page_end=max(pages) if pages else 0,
                block_ids=[block.id for block in current],
                chars=chars,
            )
        )
        current = []

    for block in blocks:
        if block.kind == "heading":
            # A heading closes the chunk before it — unless that chunk is a
            # stub, in which case a lone "Part Two" page would become a chunk
            # of four words. Stubs stay attached to what follows them.
            if sum(b.char_count for b in current) >= min_chars:
                flush()
            while stack and stack[-1].level >= block.level:
                stack.pop()
            stack.append(block)
            if not current:
                current_path = _heading_path(stack)
                current_level = block.level or 1
            current.append(block)
            continue

        if not current:
            current_path = _heading_path(stack)
            current_level = stack[-1].level if stack else 1

        current.append(block)

        if sum(b.char_count for b in current) >= target_chars:
            flush()

    flush()

    # A section split by size becomes "part 2 of 3", which is worth telling the
    # model: it explains a chunk that starts mid-argument.
    counts: Dict[Tuple[str, ...], int] = {}
    for chunk in chunks:
        key = tuple(chunk.heading_path)
        counts[key] = counts.get(key, 0) + 1
    seen: Dict[Tuple[str, ...], int] = {}
    for index, chunk in enumerate(chunks, start=1):
        key = tuple(chunk.heading_path)
        seen[key] = seen.get(key, 0) + 1
        chunk.part, chunk.parts = seen[key], counts[key]
        chunk.id = f"c{index:03d}"

    return chunks


# ------------------------------------------------------------------- terms ---


def score_terms(
    texts: Sequence[str], limit: int = TOP_TERMS
) -> List[List[str]]:
    """The most distinctive words of each text, by TF-IDF over the set.

    Same tokeniser and same `log(1 + N/df)` weighting the retrieval side uses,
    so a term that identifies a chunk here is a term that will find it there.
    """
    documents = [tokenize(text) for text in texts]
    total = len(documents) or 1

    frequency: Dict[str, int] = {}
    for words in documents:
        for word in set(words):
            frequency[word] = frequency.get(word, 0) + 1

    out: List[List[str]] = []
    for words in documents:
        counts: Dict[str, int] = {}
        for word in words:
            counts[word] = counts.get(word, 0) + 1
        scored = [
            (count * math.log(1 + total / frequency[word]), word)
            for word, count in counts.items()
            # A word appearing in almost every chunk describes the document,
            # not the chunk.
            if frequency[word] <= max(2, total * 0.6)
        ]
        scored.sort(reverse=True)
        out.append([word for _, word in scored[:limit]])
    return out


def attach_terms(chunks: List[Chunk], texts: Sequence[str]) -> None:
    for chunk, terms in zip(chunks, score_terms(texts)):
        chunk.terms = terms
