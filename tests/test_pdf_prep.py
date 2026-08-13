"""Tests for the PDF -> document.md + document.json pipeline.

    python3 -m unittest discover -s tests -p 'test_*.py'   (from the repo root)

Most of this runs on hand-built pages: every stage after reading is a pure
function over lines with boxes, so a page can be written out in the test and
fed straight in. The end-to-end classes build real PDFs — one Latin, one
Hebrew with genuine right-to-left layout, and a scanned copy of the Hebrew one
— and skip themselves when PyMuPDF, the test font or tesseract is missing.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.pdf_prep.blocks import (  # noqa: E402
    body_size,
    build_blocks,
    document_title,
    is_list_item,
    looks_like_formula,
)
from tools.pdf_prep.chunk import (  # noqa: E402
    build_chunks,
    build_sections,
    score_terms,
)
from tools.pdf_prep.emit import build_manifest, render_markdown  # noqa: E402
from tools.pdf_prep.model import Block, Document, Line, PageContent, Span, Table  # noqa: E402
from tools.pdf_prep.objects import looks_like_caption  # noqa: E402
from tools.pdf_prep.order import find_gutters, sort_page  # noqa: E402
from tools.pdf_prep.read import normalise, normalise_run, ocr_languages  # noqa: E402
from tools.pdf_prep.tidy import repair_direction, tidy_pages  # noqa: E402

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

try:
    import pymupdf
except ImportError:  # pragma: no cover - exercised only on a bare machine
    pymupdf = None


# --------------------------------------------------------------- fixtures ---


def line(text, page=1, top=100.0, x0=60.0, size=11.0, bold=False, height=13.0,
         width=None, pad_left=False, pad_right=False, font="Body"):
    """One line, at a plausible place on an A4 page."""
    span_width = width if width is not None else len(text) * size * 0.5
    bbox = (x0, top, x0 + span_width, top + height)
    return Line(
        text=text,
        page=page,
        bbox=bbox,
        size=size,
        bold=bold,
        spans=[Span(text=text, size=size, font=font, flags=16 if bold else 0, bbox=bbox)],
        pad_left=pad_left,
        pad_right=pad_right,
    )


def page_of(lines, number=1, height=842.0, width=595.0):
    page = PageContent(number=number, width=width, height=height, lines=lines)
    for order, item in enumerate(page.lines):
        item.order = order
    return page


def stacked(texts, page=1, top=100.0, step=16.0, **kwargs):
    """Lines under each other, the way a paragraph is set."""
    return [
        line(text, page=page, top=top + index * step, **kwargs)
        for index, text in enumerate(texts)
    ]


# ------------------------------------------------------------ normalising ---


class NormaliseTests(unittest.TestCase):
    def test_superscripts_survive(self):
        # NFKC would turn this into "c2", which is a different equation.
        self.assertEqual(normalise("E = mc²"), "E = mc²")

    def test_invisible_characters_go(self):
        self.assertEqual(normalise("א‏ב­"), "אב")

    def test_hebrew_presentation_forms_are_folded(self):
        self.assertEqual(normalise("שׁ"), "שׁ")

    def test_runs_keep_their_edges(self):
        self.assertEqual(normalise_run("  two   words "), " two words ")
        self.assertEqual(normalise("  two   words "), "two words")


# --------------------------------------------------------- reading order ---


class ReadingOrderTests(unittest.TestCase):
    def test_two_columns_are_read_one_at_a_time(self):
        left = stacked(["left one", "left two", "left three"], x0=60, width=180)
        right = stacked(["right one", "right two", "right three"], x0=320, width=180)
        page = page_of(left + right)

        order = [item.text for item in sort_page(page)]
        self.assertEqual(
            order,
            ["left one", "left two", "left three",
             "right one", "right two", "right three"],
        )

    def test_a_heading_across_the_gutter_does_not_kill_the_columns(self):
        """The bug this was written for: a spanning line closed the channel."""
        heading = line("A heading that spans the whole page", top=60, x0=60, width=470)
        left = stacked(["left one", "left two", "left three"], top=100, x0=60, width=180)
        right = stacked(["right one", "right two", "right three"], top=100, x0=320, width=180)
        page = page_of([heading] + left + right)

        order = [item.text for item in sort_page(page)]
        self.assertEqual(order[0], "A heading that spans the whole page")
        self.assertEqual(order[1:4], ["left one", "left two", "left three"])

    def test_a_page_of_one_column_finds_no_gutter(self):
        page = page_of(stacked(["one", "two", "three", "four", "five", "six"], width=440))
        self.assertEqual(find_gutters(page.lines, page.width), [])

    def test_right_to_left_reads_the_right_column_first(self):
        left = stacked(["שמאל א", "שמאל ב", "שמאל ג"], x0=60, width=180)
        right = stacked(["ימין א", "ימין ב", "ימין ג"], x0=320, width=180)
        page = page_of(left + right)

        order = [item.text for item in sort_page(page, "rtl")]
        self.assertEqual(order[0], "ימין א")
        self.assertEqual(order[3], "שמאל א")

    def test_bidi_fragments_of_one_line_are_fused(self):
        """A right-to-left line arrives as one piece per direction run."""
        pieces = [
            line("פרק 1", top=100, x0=460, width=60, pad_right=True),
            line("—", top=100, x0=440, width=12),
            line("חוזים", top=100, x0=380, width=55, pad_right=True),
        ]
        page = page_of(pieces)
        merged = sort_page(page, "rtl")
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0].text, "פרק 1 — חוזים")

    def test_a_word_split_by_a_font_change_is_not_split_by_a_space(self):
        pieces = [
            line("Def", top=100, x0=60, width=20, bold=True),
            line("inition", top=100, x0=80, width=40),
        ]
        merged = sort_page(page_of(pieces))
        self.assertEqual(merged[0].text, "Definition")


# ---------------------------------------------------------------- tidying ---


class TidyTests(unittest.TestCase):
    def _book(self):
        pages = []
        for number in range(1, 7):
            pages.append(page_of(
                [line("The Quarterly Review — Volume 4", page=number, top=30, size=8)]
                + stacked(
                    [f"Body text on page {number}, which is different every time.",
                     "A second line of body text, also different in every case."],
                    page=number, top=120,
                )
                + [line(str(number), page=number, top=800, size=9)],
                number=number,
            ))
        return pages

    def test_running_headers_and_page_numbers_go(self):
        pages = self._book()
        stats = tidy_pages(pages)
        self.assertEqual(stats["headers"], 6)
        self.assertEqual(stats["page_numbers"], 6)
        for page in pages:
            self.assertEqual(len(page.lines), 2)
            self.assertNotIn("Quarterly", page.text)
        # Nothing is thrown away silently.
        self.assertIn("The Quarterly Review — Volume 4", pages[0].dropped)

    def test_body_text_at_a_page_edge_stays(self):
        pages = self._book()
        keeper = "Body text on page 3, which is different every time."
        tidy_pages(pages)
        self.assertIn(keeper, pages[2].text)

    def test_a_contents_page_is_emptied_but_still_numbered(self):
        pages = self._book()
        pages[1].lines = stacked(
            ["Chapter 1 — Beginnings .......... 3",
             "Chapter 2 — Middles .......... 25",
             "Chapter 3 — Ends .......... 51",
             "Chapter 4 — Afterwards .......... 77"],
            page=2,
        )
        stats = tidy_pages(pages)
        self.assertEqual(stats["contents_pages"], 1)
        self.assertTrue(pages[1].is_toc)
        self.assertEqual(pages[1].lines, [])
        self.assertEqual(pages[2].number, 3)

    def test_hyphenated_words_are_rejoined(self):
        pages = [page_of(stacked(["a consid-", "eration of the matter"]))]
        tidy_pages(pages)
        self.assertIn("a consideration", pages[0].text)
        self.assertNotIn("consid-", pages[0].text)
        blocks, _ = build_blocks(pages, hebrew=False)
        self.assertEqual(blocks[0].text, "a consideration of the matter")

    def test_visually_ordered_hebrew_is_flipped(self):
        forwards = ("חוזה הוא הסכם מחייב בין שני צדדים, וכל אחד מהם רשאי "
                    "לבטל אותו אם יש הפרה של התנאים")
        pages = [page_of(stacked([forwards[::-1]] * 3))]
        self.assertTrue(repair_direction(pages))
        self.assertIn("הסכם מחייב", pages[0].text)

    def test_english_is_left_alone(self):
        pages = [page_of(stacked(["A plain English sentence about nothing at all."] * 3))]
        self.assertFalse(repair_direction(pages))


# ------------------------------------------------------------ classifying ---


class ClassifyTests(unittest.TestCase):
    def test_size_makes_a_heading_and_ranks_it(self):
        pages = [page_of(
            [line("The Book", top=60, size=24, bold=True),
             line("Chapter One", top=120, size=16, bold=True)]
            + stacked(["Body text that goes on for a while, as body text does."] * 4, top=200)
        )]
        blocks, _ = build_blocks(pages, hebrew=False)
        headings = [(b.text, b.level) for b in blocks if b.kind == "heading"]
        self.assertEqual(headings, [("The Book", 1), ("Chapter One", 2)])

    def test_wording_makes_a_heading_when_every_size_is_the_same(self):
        pages = [page_of(stacked(
            ["פרק 2 — מיסוי",
             "מס רכישה מוטל על רוכש זכות במקרקעין בהתאם לשווי העסקה.",
             "שיעור המס נקבע לפי מספר הדירות שבבעלות הרוכש."],
        ))]
        blocks, _ = build_blocks(pages, hebrew=True)
        self.assertEqual(blocks[0].kind, "heading")
        # The heading is kept as the page prints it, number and all.
        self.assertEqual(blocks[0].text, "פרק 2 — מיסוי")
        self.assertEqual(blocks[1].kind, "paragraph")

    def test_a_paragraph_set_large_is_not_a_heading(self):
        long_text = "A pull quote that runs on and on " * 5
        pages = [page_of(
            [line(long_text, top=60, size=20)]
            + stacked(["Ordinary body text here."] * 4, top=200)
        )]
        blocks, _ = build_blocks(pages, hebrew=False)
        self.assertEqual(blocks[0].kind, "paragraph")

    def test_lines_of_a_paragraph_are_joined(self):
        pages = [page_of(stacked(
            ["The rule is simple enough to state, and the whole of it fits",
             "on two lines of an ordinary page without any trouble at all."],
            width=440,
        ))]
        blocks, _ = build_blocks(pages, hebrew=False)
        self.assertEqual(len(blocks), 1)
        self.assertIn("state, and the whole of it fits on two lines", blocks[0].text)

    def test_a_wide_gap_starts_a_new_paragraph(self):
        first = stacked(["First paragraph, first line, running the full width.",
                         "First paragraph, second line, also the full width."], width=440)
        second = stacked(["Second paragraph, arriving after a wide gap indeed."],
                         top=180, width=440)
        blocks, _ = build_blocks([page_of(first + second)], hebrew=False)
        self.assertEqual(len(blocks), 2)

    def test_a_sentence_broken_by_a_page_break_is_rejoined(self):
        one = page_of(stacked(["The sentence begins on one page and"], page=1, top=700), number=1)
        two = page_of(stacked(["finishes on the next one."], page=2, top=100), number=2)
        blocks, _ = build_blocks([one, two], hebrew=False)
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0].pages, [1, 2])
        self.assertIn("one page and finishes on the next", blocks[0].text)

    def test_lists_are_collected(self):
        pages = [page_of(stacked(
            ["• Measure before you cut.", "• Write the test first.", "• Name it well."],
        ))]
        blocks, _ = build_blocks(pages, hebrew=False)
        self.assertEqual(blocks[0].kind, "list")
        self.assertEqual(len(blocks[0].items), 3)
        self.assertEqual(blocks[0].items[0], "Measure before you cut.")

    def test_a_right_to_left_bullet_at_the_end_of_the_line(self):
        self.assertTrue(is_list_item("אכיפה של החוזה•"))
        blocks, _ = build_blocks(
            [page_of(stacked(["אכיפה של החוזה•", "ביטול החוזה והשבה•"]))], hebrew=True
        )
        self.assertEqual(blocks[0].kind, "list")
        self.assertEqual(blocks[0].items, ["אכיפה של החוזה", "ביטול החוזה והשבה"])

    def test_formulas_are_recognised_and_sentences_are_not(self):
        self.assertTrue(looks_like_formula(line("E = mc² + ∑ pᵢ")))
        self.assertTrue(looks_like_formula(line("∫ f(x) dx ≈ 0")))
        self.assertFalse(looks_like_formula(line("Revenue = income - costs for the year")))
        self.assertFalse(looks_like_formula(line("A plain sentence with no symbols.")))

    def test_footnotes_need_all_three_signals(self):
        body = stacked(["Body text of the page, in the ordinary size."] * 3, top=100)
        note = line("1 A note at the foot of the page.", top=700, size=8)
        blocks, _ = build_blocks([page_of(body + [note])], hebrew=False)
        footnotes = [b for b in blocks if b.kind == "footnote"]
        self.assertEqual(len(footnotes), 1)
        self.assertEqual(footnotes[0].marker, "1")

        # Same line, same size, but in the middle of the page: not a footnote.
        blocks, _ = build_blocks(
            [page_of(body + [line("1 A note at the foot of the page.", top=300, size=8)])],
            hebrew=False,
        )
        self.assertFalse([b for b in blocks if b.kind == "footnote"])

    def test_captions_are_recognised_in_both_languages(self):
        self.assertTrue(looks_like_caption("Figure 2: a coloured rectangle"))
        self.assertTrue(looks_like_caption("איור 3 — תרשים זרימה"))
        self.assertTrue(looks_like_caption("טבלה 1: מדרגות מס"))
        self.assertFalse(looks_like_caption("The figure above shows the rise."))

    def test_body_size_is_weighted_by_characters(self):
        pages = [page_of(
            [line("A Heading", size=30)]
            + stacked(["Body text, of which there is much more than heading."] * 5, top=200)
        )]
        self.assertEqual(body_size(pages), 11.0)

    def test_the_title_comes_from_the_document_when_metadata_is_a_filename(self):
        blocks = [Block(kind="heading", text="The Practical Guide", level=1, pages=[1])]
        self.assertEqual(
            document_title(blocks, meta_title="Microsoft Word - final_v3.doc"),
            "The Practical Guide",
        )
        self.assertEqual(
            document_title(blocks, meta_title="A Real Title From The File"),
            "A Real Title From The File",
        )


# ------------------------------------------------- outline, chunks, terms ---


class StructureTests(unittest.TestCase):
    def _blocks(self):
        return [
            Block(kind="heading", text="Part One", level=1, pages=[1], id="b1"),
            Block(kind="paragraph", text="x" * 300, pages=[1], id="b2"),
            Block(kind="heading", text="Chapter 1", level=2, pages=[2], id="b3"),
            Block(kind="paragraph", text="y" * 300, pages=[2], id="b4"),
            Block(kind="heading", text="Chapter 2", level=2, pages=[5], id="b5"),
            Block(kind="paragraph", text="z" * 300, pages=[5, 6], id="b6"),
        ]

    def test_sections_nest_and_carry_page_ranges(self):
        sections = build_sections(self._blocks(), last_page=6)
        self.assertEqual(len(sections), 1)
        root = sections[0]
        self.assertEqual(root.title, "Part One")
        self.assertEqual((root.page_start, root.page_end), (1, 6))
        self.assertEqual([c.title for c in root.children], ["Chapter 1", "Chapter 2"])
        # A chapter ends where the next one of its level starts, not before.
        self.assertEqual((root.children[0].page_start, root.children[0].page_end), (2, 4))
        self.assertEqual(root.children[1].path, ["Part One", "Chapter 2"])

    def test_chunks_break_on_headings(self):
        chunks = build_chunks(self._blocks(), target_chars=4000, min_chars=100)
        self.assertEqual([c.heading_path for c in chunks], [
            ["Part One"],
            ["Part One", "Chapter 1"],
            ["Part One", "Chapter 2"],
        ])
        self.assertEqual(chunks[2].page_start, 5)
        self.assertEqual(chunks[2].page_end, 6)

    def test_a_long_section_is_split_at_a_block_boundary(self):
        blocks = [Block(kind="heading", text="One", level=1, pages=[1], id="h")]
        blocks += [
            Block(kind="paragraph", text="w" * 500, pages=[1], id=f"b{i}")
            for i in range(6)
        ]
        chunks = build_chunks(blocks, target_chars=1000)
        self.assertGreater(len(chunks), 2)
        self.assertEqual(chunks[0].parts, len(chunks))
        self.assertEqual([c.part for c in chunks], list(range(1, len(chunks) + 1)))
        # No paragraph was cut in half: every block belongs to exactly one chunk.
        assigned = [bid for chunk in chunks for bid in chunk.block_ids]
        self.assertEqual(len(assigned), len(set(assigned)))
        self.assertEqual(len(assigned), len(blocks))

    def test_a_stub_section_does_not_become_a_chunk_of_its_own(self):
        blocks = [
            Block(kind="heading", text="Part Two", level=1, pages=[9], id="h1"),
            Block(kind="heading", text="Chapter 5", level=2, pages=[10], id="h2"),
            Block(kind="paragraph", text="q" * 900, pages=[10], id="b1"),
        ]
        chunks = build_chunks(blocks, target_chars=4000, min_chars=400)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].heading_path, ["Part Two"])

    def test_terms_prefer_what_is_distinctive(self):
        terms = score_terms([
            "contracts and their breach, remedies for breach of contract",
            "taxation of property, purchase tax and its brackets",
        ])
        self.assertIn("breach", terms[0])
        self.assertIn("tax", " ".join(terms[1]))
        self.assertNotIn("breach", terms[1])


# ----------------------------------------------------------------- output ---


class EmitTests(unittest.TestCase):
    def _document(self):
        table = Table(
            page=2,
            bbox=(0, 0, 100, 100),
            rows=[["2021", "120"], ["2022", "340"]],
            header=["Year", "Count"],
            id="t001",
            caption="Table 1: results",
        )
        blocks = [
            Block(kind="heading", text="Chapter 1", level=1, pages=[1], id="b0001"),
            Block(kind="paragraph", text="A paragraph.", pages=[1], id="b0002"),
            Block(kind="list", items=["first", "second"], pages=[1], id="b0003"),
            Block(kind="table", table=table, pages=[2], id="b0004"),
            Block(kind="formula", text="E = mc²", pages=[2], id="b0005"),
            Block(kind="footnote", text="A note.", marker="1", pages=[2], id="b0006"),
        ]
        document = Document(
            path="book.pdf", title="A Book", language="en", page_count=2, blocks=blocks
        )
        document.sections = build_sections(blocks, last_page=2)
        document.chunks = build_chunks(blocks, target_chars=4000, min_chars=10)
        return document

    def test_markdown_has_the_shapes_a_reader_expects(self):
        markdown = render_markdown(self._document())
        self.assertIn("# A Book", markdown)
        self.assertIn("## Chapter 1", markdown)
        self.assertIn("<!-- page 1 -->", markdown)
        self.assertIn("<!-- page 2 -->", markdown)
        self.assertIn("- first", markdown)
        self.assertIn("| Year | Count |", markdown)
        self.assertIn("| --- | --- |", markdown)
        self.assertIn("$$\nE = mc²\n$$", markdown)
        self.assertIn("[^2-1]: A note.", markdown)

    def test_page_markers_can_be_turned_off(self):
        self.assertNotIn("<!-- page", render_markdown(self._document(), page_markers=False))

    def test_a_pipe_in_a_cell_does_not_end_the_column(self):
        document = self._document()
        table = document.blocks[3].table
        table.rows = [["a|b", "c"]]
        self.assertIn(r"| a\|b | c |", render_markdown(document))

    def test_offsets_point_at_the_block_they_belong_to(self):
        document = self._document()
        markdown = render_markdown(document)
        manifest = build_manifest(document, markdown, full_block_index=True)
        for entry in manifest["blocks"]:
            block = next(b for b in document.blocks if b.id == entry["id"])
            if block.kind == "footnote":
                continue
            sliced = markdown[entry["md_start"]:entry["md_end"]]
            if block.kind == "paragraph":
                self.assertEqual(sliced.strip(), block.text)
            elif block.kind == "heading":
                self.assertIn(block.text, sliced)

    def test_chunk_ranges_do_not_overlap(self):
        document = self._document()
        markdown = render_markdown(document)
        manifest = build_manifest(document, markdown)
        edge = 0
        for chunk in manifest["chunks"]:
            self.assertGreaterEqual(chunk["md_start"], edge)
            self.assertGreater(chunk["md_end"], chunk["md_start"])
            edge = chunk["md_end"]

    def test_paragraphs_are_indexed_only_when_asked_for(self):
        document = self._document()
        markdown = render_markdown(document)

        compact = build_manifest(document, markdown)
        self.assertEqual(compact["document"]["block_index"], "structural")
        self.assertNotIn("paragraph", [b["kind"] for b in compact["blocks"]])
        self.assertIn("table", [b["kind"] for b in compact["blocks"]])

        full = build_manifest(document, markdown, full_block_index=True)
        self.assertEqual(full["document"]["block_index"], "full")
        self.assertEqual(len(full["blocks"]), len(document.blocks))
        # Either way the counts describe the whole document, not the index.
        self.assertEqual(compact["counts"]["paragraphs"], full["counts"]["paragraphs"])

    def test_the_manifest_publishes_the_table_as_data(self):
        document = self._document()
        manifest = build_manifest(document, render_markdown(document))
        self.assertEqual(manifest["counts"]["tables"], 1)
        table = manifest["tables"][0]
        self.assertEqual(table["header"], ["Year", "Count"])
        self.assertEqual(table["data"], [["2021", "120"], ["2022", "340"]])
        self.assertEqual(table["page"], 2)

    def test_the_manifest_is_json(self):
        document = self._document()
        manifest = build_manifest(document, render_markdown(document))
        json.loads(json.dumps(manifest, ensure_ascii=False))
        self.assertEqual(manifest["schema"], "pdf-prep/1")
        self.assertEqual(manifest["document"]["page_count"], 2)


# ------------------------------------------------------------ end to end ---


def _write_pdf(path, pages_html, css, header=None):
    """Build a PDF whose text is laid out by a real engine (bidi included)."""
    archive = pymupdf.Archive()
    archive.add(os.path.dirname(FONT))
    doc = pymupdf.open()
    for number, html in enumerate(pages_html, start=1):
        page = doc.new_page(width=595, height=842)
        if header:
            page.insert_htmlbox(pymupdf.Rect(60, 30, 535, 60),
                                f"<p style='font-size:8px'>{header}</p>",
                                css=css, archive=archive)
        page.insert_htmlbox(pymupdf.Rect(60, 80, 535, 760), html, css=css, archive=archive)
        page.insert_htmlbox(pymupdf.Rect(280, 790, 320, 815),
                            f"<p style='font-size:9px'>{number}</p>",
                            css=css, archive=archive)
    doc.save(path)
    doc.close()


HEBREW_CSS = """
* { font-family: dejavu; direction: rtl; text-align: right; }
h1 { font-size: 22px; } h2 { font-size: 16px; } h3 { font-size: 13px; }
p, li { font-size: 11px; } td, th { font-size: 10px; border: 1px solid #000; padding: 3px; }
"""

HEBREW_PAGES = [
    "<h1>מדריך המשפט המעשי</h1><p>הוצאת דוגמה, תל אביב</p>",
    "<h2>תוכן העניינים</h2><p>פרק 1 — חוזים .......... 3</p>"
    "<p>פרק 2 — מיסוי .......... 4</p><p>פרק 3 — תכנון .......... 5</p>",
    "<h2>פרק 1 — חוזים</h2>"
    "<p>חוזה הוא הסכם מחייב בין שני צדדים או יותר. תוקפו של החוזה תלוי בגמירות "
    "דעת ובמסוימות של התנאים, ואלה נבחנים לפי אמות מידה אובייקטיביות.</p>"
    "<p>הפרת חוזה מזכה את הצד הנפגע בתרופות הבאות:</p>"
    "<ul><li>אכיפה של החוזה</li><li>ביטול החוזה והשבה</li></ul>",
    "<h2>פרק 2 — מיסוי</h2><p>מס רכישה מוטל על רוכש זכות במקרקעין.</p>"
    "<h3>2.1 מדרגות המס</h3><p>טבלה 1: מדרגות מס רכישה</p>"
    "<table><tr><th>מדרגה</th><th>שיעור</th></tr>"
    "<tr><td>עד מיליון ש\"ח</td><td>0%</td></tr>"
    "<tr><td>מעל מיליון ש\"ח</td><td>3.5%</td></tr></table>",
    "<h2>פרק 3 — תכנון ובנייה</h2><p>היתר בנייה נדרש לכל עבודה טעונת היתר.</p>",
]

LATIN_CSS = """
* { font-family: dejavu; }
h1 { font-size: 22px; } h2 { font-size: 16px; } h3 { font-size: 13px; }
p, li, td, th { font-size: 11px; } td, th { border: 1px solid #000; padding: 3px; }
"""

LATIN_PAGES = [
    "<h1>The Practical Guide</h1><p>An example press, London</p>",
    "<h2>Chapter 1 — Foundations</h2>"
    "<p>Everything begins with a definition. A definition is a statement that "
    "fixes the meaning of a term, so that two readers of the same page reach "
    "the same conclusion about what it says.</p>"
    "<ul><li>Measure before you cut.</li><li>Write the test first.</li></ul>",
    "<h2>Chapter 2 — Measurements</h2><p>Table 1: results by year</p>"
    "<table><tr><th>Year</th><th>Count</th></tr>"
    "<tr><td>2021</td><td>120</td></tr><tr><td>2022</td><td>340</td></tr></table>",
]


@unittest.skipIf(pymupdf is None, "PyMuPDF is not installed")
@unittest.skipUnless(os.path.exists(FONT), "the test font is not installed")
class EndToEndTests(unittest.TestCase):
    """The whole pipeline, over PDFs built for the purpose."""

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix="pdf_prep_")
        cls.latin = os.path.join(cls.directory, "latin.pdf")
        cls.hebrew = os.path.join(cls.directory, "hebrew.pdf")
        _write_pdf(cls.latin, LATIN_PAGES, LATIN_CSS, header="The Practical Guide — 7th ed.")
        _write_pdf(cls.hebrew, HEBREW_PAGES, HEBREW_CSS, header="מדריך המשפט המעשי — מהדורה שביעית")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.directory, ignore_errors=True)

    def _prepare(self, path, **kwargs):
        from tools.pdf_prep import prepare

        out = os.path.join(self.directory, os.path.basename(path) + ".out")
        document = prepare(path, output_dir=out, **kwargs)
        with open(os.path.join(out, "document.md"), encoding="utf-8") as handle:
            markdown = handle.read()
        with open(os.path.join(out, "document.json"), encoding="utf-8") as handle:
            manifest = json.load(handle)
        return document, markdown, manifest, out

    def test_latin_document(self):
        document, markdown, manifest, out = self._prepare(self.latin)

        self.assertEqual(document.title, "The Practical Guide")
        self.assertEqual(document.direction, "ltr")
        self.assertIn("## Chapter 1 — Foundations", markdown)
        self.assertIn("- Measure before you cut.", markdown)
        self.assertIn("<!-- page 3 -->", markdown)

        # The running header appears on every page of the PDF and nowhere in
        # the output; the page numbers are gone too.
        self.assertNotIn("7th ed.", markdown)
        self.assertNotIn("\n2\n", markdown)

        # A paragraph broken over three lines is one paragraph again.
        self.assertIn("fixes the meaning of a term, so that two readers", markdown)

        table = manifest["tables"][0]
        self.assertEqual(table["header"], ["Year", "Count"])
        self.assertEqual(table["data"], [["2021", "120"], ["2022", "340"]])

        self.assertEqual(manifest["document"]["chars"], len(markdown))
        self.assertEqual(manifest["extraction"]["backend"], "pymupdf")
        self.assertEqual(manifest["extraction"]["ocr_pages"], [])
        self.assertTrue(os.path.exists(os.path.join(out, "document.json")))

    def test_hebrew_document(self):
        document, markdown, manifest, _ = self._prepare(self.hebrew)

        self.assertEqual(document.language, "he")
        self.assertEqual(document.direction, "rtl")
        self.assertEqual(document.title, "מדריך המשפט המעשי")

        # Bidi runs reassembled, with the spaces the page had and no others.
        self.assertIn("פרק 1 — חוזים", markdown)
        self.assertIn("2.1 מדרגות המס", markdown)
        self.assertIn("חוזה הוא הסכם מחייב בין שני צדדים או יותר.", markdown)

        # The list is a list, not a paragraph with bullets in the middle.
        self.assertIn("- אכיפה של החוזה", markdown)

        # The contents page is gone, and page 3 is still page 3.
        self.assertNotIn("..........", markdown)
        self.assertTrue(any(p["is_contents"] for p in manifest["pages"]))
        self.assertEqual([p["number"] for p in manifest["pages"]], [1, 2, 3, 4, 5])

        # Table cells read forwards, not backwards.
        cells = [cell for row in manifest["tables"][0]["data"] for cell in row]
        self.assertIn('עד מיליון ש"ח', cells)

        titles = [section["title"] for section in manifest["outline"][0]["children"]]
        self.assertIn("פרק 1 — חוזים", titles)

    def test_the_manifest_maps_the_markdown(self):
        _, markdown, manifest, _ = self._prepare(self.latin)
        for chunk in manifest["chunks"]:
            sliced = markdown[chunk["md_start"]:chunk["md_end"]]
            self.assertTrue(sliced.strip())
            if chunk["headings"]:
                self.assertIn(chunk["headings"][0], sliced)
        for section in manifest["outline"]:
            self.assertLessEqual(section["page_start"], section["page_end"])

    def test_a_page_range_reads_only_those_pages(self):
        document, markdown, _, _ = self._prepare(self.latin, first_page=2, last_page=2)
        self.assertIn("Chapter 1", markdown)
        self.assertNotIn("Chapter 2", markdown)
        self.assertEqual([page.number for page in document.pages], [2])


@unittest.skipIf(pymupdf is None, "PyMuPDF is not installed")
@unittest.skipUnless(os.path.exists(FONT), "the test font is not installed")
@unittest.skipUnless("heb" in ocr_languages(), "tesseract with Hebrew is not installed")
class ScannedDocumentTests(unittest.TestCase):
    """The OCR path: the same document, rasterised so it has no text layer."""

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix="pdf_prep_ocr_")
        source = os.path.join(cls.directory, "hebrew.pdf")
        _write_pdf(source, HEBREW_PAGES[2:4], HEBREW_CSS)

        cls.scan = os.path.join(cls.directory, "scan.pdf")
        original, scan = pymupdf.open(source), pymupdf.open()
        for page in original:
            pixmap = page.get_pixmap(dpi=200)
            target = scan.new_page(width=page.rect.width, height=page.rect.height)
            target.insert_image(target.rect, pixmap=pixmap)
        scan.save(cls.scan)
        scan.close()
        original.close()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.directory, ignore_errors=True)

    def test_a_scan_is_recognised_and_read(self):
        from tools.pdf_prep import prepare

        out = os.path.join(self.directory, "out")
        document = prepare(self.scan, output_dir=out, ocr="auto")
        with open(os.path.join(out, "document.md"), encoding="utf-8") as handle:
            markdown = handle.read()

        self.assertEqual(document.meta["extraction"]["ocr_pages"], [1, 2])
        self.assertTrue(any("OCR" in warning for warning in document.warnings))
        self.assertIn("חוזה", markdown)
        self.assertIn("מס רכישה", markdown)

        # The scan of the page is not an illustration in the document.
        self.assertEqual(len(document.of_kind("figure")), 0)

    def test_ocr_can_be_refused(self):
        from tools.pdf_prep import prepare

        document = prepare(self.scan, ocr="never")
        self.assertEqual(document.meta["extraction"]["ocr_pages"], [])
        self.assertTrue(any("scan" in warning for warning in document.warnings))
        self.assertTrue(any("OCR was turned off" in w for w in document.warnings))


if __name__ == "__main__":
    unittest.main()
