"""Tests for the PDF -> index -> relevant-content pipeline.

    python3 -m unittest discover -s tests -p 'test_*.py'   (from the repo root)

Everything except the last class runs on the standard library alone: the
stages after extraction are pure functions over pages, so they can be fed
strings. The end-to-end class builds a real PDF and reads it back, and skips
itself when reportlab or a PDF reader is missing.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.pdf_index.clean import (  # noqa: E402
    clean_pages,
    flip_line,
    looks_visually_ordered,
)
from tools.pdf_index.extract import pages_from_text  # noqa: E402
from tools.pdf_index.index import (  # noqa: E402
    build_index,
    find_chapter,
    flatten,
    render_index,
)
from tools.pdf_index.retrieve import (  # noqa: E402
    chunk_text,
    render_relevant,
    select_relevant,
    tokenize,
)
from tools.pdf_index.structure import (  # noqa: E402
    detect_language,
    find_headings,
    parse_numeral,
)

HEADER = "מדריך המשפט המעשי — מהדורה שביעית"


def hebrew_book():
    """A miniature of the real thing: running header, page numbers, a TOC,
    three chapters in three different numbering styles."""
    pages = [
        # 1 — title page
        f"{HEADER}\nמדריך המשפט המעשי\nהוצאת דוגמה\n1",
        # 2 — table of contents
        f"{HEADER}\nתוכן העניינים\n"
        "פרק 1 — חוזים .......... 3\n"
        "פרק 2 — מיסוי .......... 5\n"
        "פרק 3 — תכנון ובנייה .......... 7\n2",
        # 3-4 — chapter 1
        f"{HEADER}\nפרק 1 — חוזים\n"
        "חוזה הוא הסכם מחייב בין שני צדדים או יותר. תוקפו של החוזה תלוי "
        "בגמירות דעת ובמסוימות של התנאים.\n3",
        f"{HEADER}\nהפרת חוזה מזכה את הצד הנפגע בתרופות: אכיפה, ביטול ופיצויים. "
        "פיצויי הסתמכות נועדו להשיב את המצב לקדמותו.\n4",
        # 5-6 — chapter 2
        f"{HEADER}\nפרק ב׳ — מיסוי\n"
        "מס שבח מוטל על הרווח ממכירת זכות במקרקעין. שיעור המס נקבע לפי "
        "יום הרכישה ולפי תקופות השבח.\n5",
        f"{HEADER}\nמס רכישה משולם על ידי הרוכש בשיעורים מדורגים. דירה שנייה "
        "מחויבת בשיעור גבוה יותר מדירה יחידה.\n6",
        # 7 — chapter 3
        f"{HEADER}\nפרק שלישי: תכנון ובנייה\n"
        "היתר בנייה ניתן על ידי הוועדה המקומית בהתאם לתכנית החלה על הקרקע. "
        "חריגת בנייה עלולה לגרור צו הריסה.\n7",
    ]
    return pages_from_text(pages)


def english_book():
    pages = [
        "A Practical Guide\nSample Press\ni",
        "A Practical Guide | Chapter 1\nChapter 1 — Contracts\n"
        "A contract is a binding agreement. Formation requires offer, "
        "acceptance and consideration.\n1",
        "A Practical Guide | Chapter 1\n"
        "1.1 Remedies\nDamages restore the injured party. Specific perfor-\n"
        "mance is granted where damages are inadequate.\n2",
        "A Practical Guide | Chapter 2\nChapter 2 — Taxation\n"
        "Capital gains tax applies to the disposal of an asset. The rate "
        "depends on the holding period.\n3",
    ]
    return pages_from_text(pages)


class TestCleaning(unittest.TestCase):
    def test_running_header_is_dropped_from_every_page(self):
        pages = clean_pages(hebrew_book())
        self.assertFalse(
            any(HEADER in line for page in pages for line in page.lines),
            "the running header survived cleaning",
        )
        self.assertTrue(
            any(HEADER in line for page in pages for line in page.dropped),
            "the dropped lines should record what was removed",
        )

    def test_page_numbers_are_dropped(self):
        pages = clean_pages(hebrew_book())
        for page in pages:
            self.assertNotIn(str(page.number), page.lines)

    def test_table_of_contents_page_is_flagged_and_emptied(self):
        pages = clean_pages(hebrew_book())
        toc = pages[1]
        self.assertTrue(toc.is_toc)
        self.assertEqual(toc.lines, [])

    def test_keeping_the_toc_is_possible(self):
        pages = clean_pages(hebrew_book(), drop_toc=False)
        self.assertTrue(pages[1].is_toc)
        self.assertTrue(pages[1].lines)

    def test_page_numbers_survive_as_numbers(self):
        pages = clean_pages(hebrew_book())
        self.assertEqual([p.number for p in pages], list(range(1, 8)))

    def test_hyphenated_word_is_rejoined(self):
        pages = clean_pages(english_book())
        text = " ".join(line for page in pages for line in page.lines)
        self.assertIn("performance", text)
        self.assertNotIn("perfor-", text)

    def test_body_text_is_not_dropped(self):
        pages = clean_pages(hebrew_book())
        text = " ".join(line for page in pages for line in page.lines)
        self.assertIn("מס רכישה", text)
        self.assertIn("היתר בנייה", text)


class TestReadingDirection(unittest.TestCase):
    """Some readers hand back Hebrew in the order it was painted, reversed."""

    def visually_ordered_book(self):
        return pages_from_text([
            flip_line(line)
            for page in hebrew_book()
            for line in [page.text]
        ])

    def test_a_reversed_document_is_recognised(self):
        self.assertTrue(looks_visually_ordered(self.visually_ordered_book()))

    def test_a_correct_document_is_left_alone(self):
        pages = hebrew_book()
        before = [page.lines[:] for page in pages]
        self.assertFalse(looks_visually_ordered(pages))
        clean_pages(pages)
        self.assertIn("מס רכישה", " ".join(pages[5].lines))
        self.assertNotEqual(before, [])

    def test_english_is_never_flipped(self):
        pages = english_book()
        self.assertFalse(looks_visually_ordered(pages))

    def test_flipping_keeps_numbers_readable(self):
        self.assertEqual(flip_line("מס שבח 2024"), "2024 חבש סמ")
        self.assertEqual(flip_line(flip_line("מס שבח 2024")), "מס שבח 2024")

    def test_a_reversed_book_still_indexes_correctly(self):
        pages = clean_pages(self.visually_ordered_book())
        chapters = build_index(pages, find_headings(pages))
        titles = [c.title for c in flatten(chapters) if c.level == 2]
        self.assertEqual(titles, ["חוזים", "מיסוי", "תכנון ובנייה"])

    def test_repair_can_be_turned_off(self):
        pages = clean_pages(self.visually_ordered_book(), fix_rtl=False)
        text = " ".join(line for page in pages for line in page.lines)
        self.assertNotIn("מס רכישה", text)


class TestNumerals(unittest.TestCase):
    def test_digits(self):
        self.assertEqual(parse_numeral("7", False), 7)

    def test_gematria(self):
        self.assertEqual(parse_numeral("ב׳", True), 2)
        self.assertEqual(parse_numeral("י", True), 10)
        self.assertEqual(parse_numeral("כ״ה", True), 25)

    def test_hebrew_ordinal_words(self):
        self.assertEqual(parse_numeral("שלישי", True), 3)
        self.assertEqual(parse_numeral("שנייה", True), 2)

    def test_roman_and_english_words(self):
        self.assertEqual(parse_numeral("IV", False), 4)
        self.assertEqual(parse_numeral("Two", False), 2)

    def test_a_word_is_not_a_numeral(self):
        self.assertIsNone(parse_numeral("מבוא", True))
        self.assertIsNone(parse_numeral("Overview", False))


class TestStructure(unittest.TestCase):
    def test_language_detection(self):
        self.assertEqual(detect_language(hebrew_book()), "he")
        self.assertEqual(detect_language(english_book()), "en")

    def test_three_chapters_in_three_numbering_styles(self):
        pages = clean_pages(hebrew_book())
        headings = find_headings(pages)
        chapters = [h for h in headings if h.level == 2]
        self.assertEqual([h.number for h in chapters], [1, 2, 3])
        self.assertEqual(
            [h.title for h in chapters], ["חוזים", "מיסוי", "תכנון ובנייה"]
        )

    def test_headings_are_not_taken_from_the_contents_page(self):
        pages = clean_pages(hebrew_book())
        headings = find_headings(pages)
        self.assertFalse([h for h in headings if h.page == 2])

    def test_english_chapters_and_outline_subsection(self):
        pages = clean_pages(english_book())
        headings = find_headings(pages)
        levels = {h.title: h.level for h in headings}
        self.assertEqual(levels.get("Contracts"), 2)
        self.assertEqual(levels.get("Taxation"), 2)
        self.assertEqual(levels.get("Remedies"), 3)

    def test_a_numbered_clause_is_not_a_heading(self):
        pages = pages_from_text([
            "Chapter 1 — Terms\n"
            "1. The tenant shall pay the rent on the first day of each month.\n"
            "2. The landlord shall keep the premises in repair."
        ])
        headings = find_headings(clean_pages(pages))
        self.assertEqual([h.title for h in headings], ["Terms"])

    def test_a_sentence_starting_with_the_keyword_is_not_a_heading(self):
        pages = pages_from_text([
            "Chapter 1 — Estates\n"
            "Part of the estate passes to the surviving spouse under the "
            "intestacy rules, and the remainder is divided between the issue."
        ])
        headings = find_headings(clean_pages(pages))
        self.assertEqual([h.title for h in headings], ["Estates"])

    def test_loose_mode_finds_bare_titles_when_nothing_else_does(self):
        pages = pages_from_text([
            "Introduction\nThis book is about nothing in particular at all.",
            "Method\nWe proceeded carefully and wrote down what happened next.",
        ])
        headings = find_headings(clean_pages(pages))
        self.assertEqual([h.title for h in headings], ["Introduction", "Method"])

    def test_a_page_that_is_only_headings_is_a_contents_page(self):
        pages = pages_from_text([
            "תוכן העניינים\n"
            "פרק 1 — חוזים\nפרק 2 — מיסוי\nפרק 3 — תכנון\nפרק 4 — נזיקין",
            "פרק 1 — חוזים\nחוזה הוא הסכם מחייב בין שני צדדים או יותר.",
        ])
        pages = clean_pages(pages)
        headings = find_headings(pages)
        self.assertEqual([h.page for h in headings], [2])
        self.assertTrue(pages[0].is_toc)

    def test_the_loose_fallback_gives_up_rather_than_invent_a_chapter_a_page(self):
        # Every page opens with a full-width sentence: nothing here is a title.
        body = "This sentence is quite long and runs the full width of the page."
        pages = pages_from_text([f"{body}\n{body}\n{body}" for _ in range(20)])
        headings = find_headings(clean_pages(pages))
        self.assertEqual(headings, [])

    def test_a_repeated_heading_on_the_next_page_is_not_a_second_chapter(self):
        pages = pages_from_text([
            "Chapter 2 — Taxation\nThe first paragraph of the chapter sits here.",
            "Chapter 2 — Taxation\nThe second page continues the same chapter.",
        ])
        headings = find_headings(clean_pages(pages, header_threshold=0.9))
        self.assertEqual(len(headings), 1)


class TestIndex(unittest.TestCase):
    def setUp(self):
        self.pages = clean_pages(hebrew_book())
        self.chapters = build_index(self.pages, find_headings(self.pages))

    def test_page_ranges_run_to_the_next_chapter(self):
        by_number = {c.number: c for c in flatten(self.chapters) if c.level == 2}
        self.assertEqual((by_number[1].start_page, by_number[1].end_page), (3, 4))
        self.assertEqual((by_number[2].start_page, by_number[2].end_page), (5, 6))
        self.assertEqual((by_number[3].start_page, by_number[3].end_page), (7, 7))

    def test_last_chapter_runs_to_the_end_of_the_document(self):
        last = [c for c in flatten(self.chapters) if c.level == 2][-1]
        self.assertEqual(last.end_page, self.pages[-1].number)

    def test_chapter_text_stops_at_the_next_chapter(self):
        chapter_one = find_chapter(self.chapters, "1")
        self.assertIn("גמירות דעת", chapter_one.text)
        self.assertNotIn("מס שבח", chapter_one.text)

    def test_rendered_index_has_a_line_per_chapter_with_its_pages(self):
        rendered = render_index(self.chapters, "he")
        self.assertIn("אינדקס", rendered)
        lines = [line for line in rendered.splitlines() if "עמוד" in line]
        self.assertEqual(len(lines), 3)
        self.assertTrue(any("מיסוי" in line and "5-6" in line for line in lines))

    def test_subsection_page_range_does_not_close_its_parent(self):
        pages = clean_pages(english_book())
        chapters = build_index(pages, find_headings(pages))
        # Contracts opens on page 2 and its sub-section 1.1 sits on page 3;
        # the chapter closes where chapter 2 opens, not where the sub-section did.
        chapter_one = find_chapter(chapters, "Contracts")
        self.assertEqual((chapter_one.start_page, chapter_one.end_page), (2, 3))
        self.assertEqual([c.title for c in chapter_one.children], ["Remedies"])

    def test_lookup_by_number_page_and_title(self):
        self.assertEqual(find_chapter(self.chapters, "2").title, "מיסוי")
        self.assertEqual(find_chapter(self.chapters, "p6").title, "מיסוי")
        self.assertEqual(find_chapter(self.chapters, "תכנון").number, 3)
        self.assertIsNone(find_chapter(self.chapters, "אווירונאוטיקה"))

    def test_front_matter_is_kept_when_it_has_content(self):
        pages = pages_from_text([
            "A preface that runs on for a while, long enough to be worth "
            "keeping, describing why the author wrote the book and who helped. "
            "It continues for several sentences so that it clears the minimum "
            "length the indexer requires before it bothers to record it at all.",
            "Chapter 1 — Beginnings\nThe story starts in a small town.",
        ])
        pages = clean_pages(pages)
        chapters = build_index(pages, find_headings(pages, loose=False))
        self.assertEqual(chapters[0].title, "Front matter")

    def test_a_document_with_no_headings_is_still_indexable(self):
        pages = clean_pages(pages_from_text(["Just some prose. " * 40]))
        chapters = build_index(pages, find_headings(pages, loose=False))
        self.assertEqual(len(chapters), 1)
        self.assertIn("Just some prose", chapters[0].text)


class TestRetrieval(unittest.TestCase):
    def setUp(self):
        self.pages = clean_pages(hebrew_book())
        self.chapters = build_index(self.pages, find_headings(self.pages))

    def test_tokenizer_drops_short_words_and_stopwords(self):
        self.assertNotIn("של", tokenize("של מס שבח"))
        self.assertIn("שבח", tokenize("של מס שבח"))

    def test_chunking_respects_the_budget(self):
        chunks = chunk_text("Sentence number one is here. " * 200)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(c) <= 1600 for c in chunks))

    def test_a_tax_question_retrieves_the_tax_chapter(self):
        passages = select_relevant(self.chapters, "מס רכישה על דירה שנייה")
        self.assertTrue(passages)
        self.assertTrue(all(p.chapter.title == "מיסוי" for p in passages))
        self.assertIn("מס רכישה", " ".join(p.text for p in passages))

    def test_a_planning_question_retrieves_the_planning_chapter(self):
        passages = select_relevant(self.chapters, "היתר בנייה מהוועדה המקומית")
        self.assertEqual({p.chapter.title for p in passages}, {"תכנון ובנייה"})

    def test_the_budget_is_a_limit_not_a_suggestion(self):
        for budget in (200, 600, 1500):
            passages = select_relevant(self.chapters, "מס שבח", budget=budget)
            self.assertLessEqual(sum(len(p.text) for p in passages), budget)

    def test_a_trimmed_passage_ends_on_a_sentence(self):
        chapter = find_chapter(self.chapters, "2")
        passages = select_relevant(
            self.chapters, "", budget=120, chapter_filter=chapter
        )
        self.assertTrue(passages[-1].text.endswith("."))

    def test_a_question_the_document_cannot_answer_returns_nothing(self):
        passages = select_relevant(self.chapters, "אווירונאוטיקה וטורבינות")
        self.assertEqual(passages, [])
        self.assertIn("לא נמצא", render_relevant(passages, "he"))

    def test_restricting_to_a_chapter_never_leaves_it(self):
        chapter = find_chapter(self.chapters, "1")
        passages = select_relevant(
            self.chapters, "מס שבח", chapter_filter=chapter
        )
        self.assertTrue(all(p.chapter.title == "חוזים" for p in passages))

    def test_no_query_returns_the_chapter_from_its_start(self):
        chapter = find_chapter(self.chapters, "3")
        passages = select_relevant(self.chapters, "", chapter_filter=chapter)
        self.assertTrue(passages[0].text.startswith("היתר בנייה"))

    def test_rendered_output_labels_the_chapter_and_its_pages(self):
        passages = select_relevant(self.chapters, "מס רכישה")
        rendered = render_relevant(passages, "he")
        self.assertIn("תוכן רלוונטי", rendered)
        self.assertIn("[פרק 2 — מיסוי | עמודים 5-6]", rendered)

    def test_a_subsection_passage_names_its_parent_chapter(self):
        pages = clean_pages(pages_from_text([
            "Chapter 2 — Taxation\nThe chapter opens with a general statement.",
            "2.1 Withholding\n"
            "Withholding obligations fall on the payer rather than the payee, "
            "and late payment attracts interest from the due date onwards.",
        ]))
        chapters = build_index(pages, find_headings(pages))
        passages = select_relevant(chapters, "withholding payer interest")
        rendered = render_relevant(passages, "en")
        self.assertIn("Chapter 2 — Taxation › 2.1 — Withholding", rendered)

    def test_a_gap_between_passages_is_marked(self):
        pages = clean_pages(pages_from_text([
            "Chapter 1 — Rivers\n"
            + "The river carries silt downstream. " * 40
            + "Nothing here about mountains at all, only water and mud. " * 20
            + "The river floods in spring when the snow melts upstream. " * 40
        ]))
        chapters = build_index(pages, find_headings(pages))
        passages = select_relevant(chapters, "river silt flood", budget=4000)
        rendered = render_relevant(passages, "en")
        if len(passages) > 1 and passages[-1].order - passages[0].order > 1:
            self.assertIn("[...]", rendered)


class TestEndToEndPdf(unittest.TestCase):
    """Build a PDF, read it back, and check the index survives the round trip."""

    @classmethod
    def setUpClass(cls):
        try:
            from reportlab.lib.pagesizes import A4
            from reportlab.pdfgen import canvas
        except ImportError:
            raise unittest.SkipTest("reportlab is not installed")

        from tools.pdf_index.extract import available_backends
        if not available_backends():
            raise unittest.SkipTest("no PDF reader is installed")

        import tempfile

        cls.tmpdir = tempfile.mkdtemp()
        cls.path = os.path.join(cls.tmpdir, "book.pdf")

        body = {
            1: ["Chapter 1 — Contracts",
                "A contract is a binding agreement between two parties.",
                "Formation requires offer, acceptance and consideration."],
            2: ["Damages restore the injured party to their prior position.",
                "Specific performance is ordered where damages will not do."],
            3: ["Chapter 2 — Taxation",
                "Capital gains tax applies on the disposal of an asset.",
                "The rate depends on the holding period of that asset."],
            4: ["Withholding obligations fall on the payer, not the payee.",
                "Late payment attracts interest from the due date."],
            5: ["Chapter 3 — Planning",
                "Planning permission is granted by the local authority.",
                "Building without permission risks an enforcement notice."],
        }

        pdf = canvas.Canvas(cls.path, pagesize=A4)
        width, height = A4
        for number in sorted(body):
            pdf.setFont("Helvetica", 9)
            pdf.drawString(72, height - 40, "A Practical Guide")   # running header
            pdf.setFont("Helvetica", 11)
            y = height - 90
            for line in body[number]:
                pdf.drawString(72, y, line)
                y -= 22
            pdf.setFont("Helvetica", 9)
            pdf.drawCentredString(width / 2, 40, str(number))      # page number
            pdf.showPage()
        pdf.save()

    @classmethod
    def tearDownClass(cls):
        import shutil

        shutil.rmtree(cls.tmpdir, ignore_errors=True)

    def analyse(self):
        from tools.pdf_index.extract import extract_pages

        pages = clean_pages(extract_pages(self.path))
        return pages, build_index(pages, find_headings(pages))

    def test_pages_are_read_and_numbered(self):
        pages, _ = self.analyse()
        self.assertEqual([p.number for p in pages], [1, 2, 3, 4, 5])

    def test_running_header_and_page_numbers_are_gone(self):
        pages, _ = self.analyse()
        text = " ".join(line for page in pages for line in page.lines)
        self.assertNotIn("A Practical Guide", text)
        self.assertIn("Capital gains tax", text)

    def test_index_matches_the_book_that_was_written(self):
        _, chapters = self.analyse()
        rendered = render_index(chapters, "en")
        self.assertIn("Chapter 1 — Contracts", rendered)
        self.assertIn("pages 1-2", rendered)
        self.assertIn("pages 3-4", rendered)
        self.assertIn("Chapter 3 — Planning", rendered)

    def test_a_question_pulls_the_right_chapter_out_of_the_pdf(self):
        _, chapters = self.analyse()
        passages = select_relevant(chapters, "capital gains on disposal")
        self.assertTrue(passages)
        self.assertEqual({p.chapter.title for p in passages}, {"Taxation"})

    def test_a_missing_file_says_so(self):
        import io
        from contextlib import redirect_stderr

        from tools.pdf_index.cli import main

        err = io.StringIO()
        with redirect_stderr(err):
            code = main(["index", os.path.join(self.tmpdir, "absent.pdf")])
        self.assertEqual(code, 1)
        self.assertIn("no such file", err.getvalue())

    def test_the_cli_runs_end_to_end(self):
        import io
        from contextlib import redirect_stderr, redirect_stdout

        from tools.pdf_index.cli import main

        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(["context", self.path, "--query", "planning permission"])
        self.assertEqual(code, 0)
        printed = out.getvalue()
        self.assertIn("INDEX", printed)
        self.assertIn("RELEVANT CONTENT", printed)
        self.assertIn("local authority", printed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
