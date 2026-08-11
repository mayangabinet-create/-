"""Stage 5 — pick the passages a question actually needs.

Same scoring the browser uses in `app.js` (`retrieveExcerpt`), on purpose:
tokens longer than two characters, TF-IDF with `log(1 + N/df)`, and a
relevance floor so a budget is never filled with whatever ranked fourth. The
difference is what it scores over. In the browser the corpus is a truncated
prefix of the document; here it is the whole 300 pages, chunked inside
chapter boundaries, so a passage arrives with its chapter and page attached
and the model can be told where the answer came from.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, replace
from typing import Dict, List, Optional, Tuple

from .index import Chapter, LABELS, flatten

CHUNK_CHARS = 1200
CHUNK_OVERLAP = 150
RELEVANCE_FLOOR = 0.55   # a chunk must score at least this share of the best

STOPWORDS = {
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "her",
    "was", "one", "our", "out", "has", "have", "with", "this", "that",
    "from", "they", "been", "will", "would", "their", "when", "which",
    "there", "what", "about", "into", "than", "then", "them", "these",
    # Hebrew's function words are mostly prefixes, but these stand alone.
    "של", "את", "על", "עם", "לא", "כל", "זה", "זו", "אשר", "אבל", "גם",
    "היא", "הוא", "הם", "הן", "כי", "אם", "או", "יש", "אין",
}

_WORD_SPLIT = re.compile(r"[^\w]+", re.UNICODE)
_SENTENCE = re.compile(r"[^.!?。！？׃]+[.!?。！？׃]+|\S+$")


@dataclass
class Passage:
    """A chunk of one chapter, with everything needed to cite it."""

    text: str
    chapter: Chapter
    order: int          # position within the chapter, for reassembly
    page_hint: int
    score: float = 0.0


def tokenize(text: str) -> List[str]:
    return [
        word
        for word in _WORD_SPLIT.split((text or "").lower())
        if len(word) > 2 and word not in STOPWORDS
    ]


def chunk_text(text: str) -> List[str]:
    """Split on sentence boundaries. A chunk cut mid-sentence invites invention."""
    clean = re.sub(r"\s+", " ", text or "").strip()
    if not clean:
        return []
    if len(clean) <= CHUNK_CHARS:
        return [clean]

    chunks: List[str] = []
    current = ""
    for sentence in _SENTENCE.findall(clean):
        if len(current) + len(sentence) > CHUNK_CHARS and len(current) > 200:
            chunks.append(current.strip())
            # Carry a sentence of overlap so a concept on the seam is in both.
            tail = current[-CHUNK_OVERLAP:]
            cut = re.search(r"[.!?。！？׃]\s", tail)
            current = (tail[cut.end():] if cut else "") + sentence
        else:
            current += sentence
    if current.strip():
        chunks.append(current.strip())
    return chunks


def build_passages(chapters: List[Chapter]) -> List[Passage]:
    passages: List[Passage] = []
    for chapter in flatten(chapters):
        for order, chunk in enumerate(chunk_text(chapter.text)):
            passages.append(
                Passage(
                    text=chunk,
                    chapter=chapter,
                    order=order,
                    page_hint=chapter.start_page,
                )
            )
    return passages


def _score_all(passages: List[Passage], query: str) -> List[Passage]:
    query_tokens = tokenize(query)
    if not query_tokens:
        return []

    tokenized = [tokenize(p.text) for p in passages]
    doc_freq: Dict[str, int] = {}
    for tokens in tokenized:
        for token in set(tokens):
            doc_freq[token] = doc_freq.get(token, 0) + 1

    total = max(len(passages), 1)
    for passage, tokens in zip(passages, tokenized):
        counts: Dict[str, int] = {}
        for token in tokens:
            counts[token] = counts.get(token, 0) + 1
        score = 0.0
        for token in query_tokens:
            tf = counts.get(token)
            if not tf:
                continue
            idf = math.log(1 + total / doc_freq.get(token, 1))
            score += (1 + math.log(tf)) * idf
        passage.score = score

    return [p for p in passages if p.score > 0]


def select_relevant(
    chapters: List[Chapter],
    query: str,
    budget: int = 12000,
    chapter_filter: Optional[Chapter] = None,
) -> List[Passage]:
    """The passages worth spending the budget on, in document order.

    With a `chapter_filter` the search is confined to that chapter (and its
    sub-sections) — "answer from chapter 2" rather than "answer from the book".
    With no query at all the chapter is returned from its start, which is what
    a reader asking for chapter 2 expects.
    """
    scope = [chapter_filter] if chapter_filter else chapters
    passages = build_passages(scope)
    if not passages:
        return []

    if not query.strip():
        return _trim(_fill_in_order(passages, budget), budget)

    ranked = sorted(_score_all(passages, query), key=lambda p: -p.score)
    if not ranked:
        # Nothing in the document shares a word with the question. Returning
        # the opening pages instead would look like an answer and be one only
        # by accident, so say nothing and let the caller report it.
        return []

    best = ranked[0].score
    picked: List[Passage] = []
    remaining = budget
    for passage in ranked:
        if remaining <= 0:
            break
        if passage.score < best * RELEVANCE_FLOOR:
            break   # sorted descending, so nothing after this qualifies either
        if len(passage.text) > remaining and picked:
            continue
        picked.append(passage)
        remaining -= len(passage.text)

    return _trim(_in_document_order(picked), budget)


def _fill_in_order(passages: List[Passage], budget: int) -> List[Passage]:
    out: List[Passage] = []
    for passage in passages:
        if budget <= 0:
            break
        out.append(passage)
        budget -= len(passage.text)
    return out


def _trim(passages: List[Passage], budget: int) -> List[Passage]:
    """Cut the tail so the budget is a limit rather than a suggestion.

    A budget that a single chunk can overrun by 1,200 characters is not a
    budget, and the caller sizing a prompt around it will be wrong. The cut
    falls back to the last sentence end so the model is not handed half a
    sentence to finish from imagination.
    """
    out: List[Passage] = []
    remaining = budget
    for passage in passages:
        if remaining <= 0:
            break
        if len(passage.text) <= remaining:
            out.append(passage)
            remaining -= len(passage.text)
            continue

        head = passage.text[:remaining]
        cut = max(head.rfind(ender) for ender in ".!?׃。")
        if cut > remaining * 0.4:
            head = head[: cut + 1]
        out.append(replace(passage, text=head.strip()))
        break
    return [p for p in out if p.text]


def _in_document_order(passages: List[Passage]) -> List[Passage]:
    return sorted(passages, key=lambda p: (p.chapter.start_page, p.order))


def render_relevant(passages: List[Passage], language: str = "he") -> str:
    """Group the passages under their chapter, marking every gap.

    Without the gap markers the model reads two distant paragraphs as one
    argument and invents the bridge between them.
    """
    words = LABELS.get(language, LABELS["en"])
    if not passages:
        return f"{words['relevant']}\n\n{words['nothing']}"

    out = [words["relevant"], ""]

    current: Optional[Chapter] = None
    previous_order = -99
    for passage in passages:
        if passage.chapter is not current:
            if current is not None:
                out.append("")
            label = passage.chapter.path_label
            out.append(f"[{label} | {words['pages']} {passage.chapter.page_range}]")
            current = passage.chapter
        elif passage.order != previous_order + 1:
            out.append("[...]")
        out.append(passage.text)
        previous_order = passage.order

    return "\n".join(out)


def coverage(passages: List[Passage]) -> Tuple[int, int]:
    """(characters selected, chapters touched) — for the CLI's summary line."""
    chars = sum(len(p.text) for p in passages)
    return chars, len({id(p.chapter) for p in passages})
