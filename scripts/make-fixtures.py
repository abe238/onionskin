"""Writes test fixtures into the directory given as argv[1] (always a temp dir; nothing is written into the repo).
budget.xlsx: sheets Summary, Budget (header row frozen, 60 line items, a defined name), Notes.
deck.pptx: 6 slides, each with a title and a body; slide 4 also has a text box.
long.docx: 300 distinct, real-ish paragraphs (python-docx writes no w14:paraId, so durable anchors fall back to hash/quote)."""
import sys
from docx import Document
import openpyxl
from openpyxl.workbook.defined_name import DefinedName
from pptx import Presentation
from pptx.util import Inches

TOPICS = ["budget", "staffing", "logistics", "security", "training", "procurement", "reporting", "scheduling", "compliance", "outreach"]
VERBS = ["reviews", "updates", "confirms", "documents", "tracks", "approves", "summarizes", "audits"]


def paragraph_text(i: int) -> str:
    t = TOPICS[i % len(TOPICS)]
    v = VERBS[(i * 3) % len(VERBS)]
    return (
        f"Paragraph {i:03d}: the {t} team {v} item {i * 7 + 13} each quarter and files a short note "
        f"so that regional leads can compare results across offices without waiting for the annual cycle."
    )


def main(out: str) -> None:
    d = Document()
    d.add_heading("Operations handbook", level=1)
    for i in range(1, 301):
        if i % 50 == 1:
            d.add_heading(f"Part {i // 50 + 1}", level=2)
        d.add_paragraph(paragraph_text(i))
    d.save(f"{out}/long.docx")


def budget(out: str) -> None:
    wb = openpyxl.Workbook()
    s = wb.active
    s.title = "Summary"
    s["A1"] = "Budget overview"
    s["A3"] = "Prepared for"
    s["B3"] = "Finance committee"
    b = wb.create_sheet("Budget")
    b.append(["Item", "Owner", "Q1", "Q2", "Total"])
    owners = ["Ana", "Ben", "Cy", "Dee", "Eli"]
    for i in range(1, 61):
        r = i + 1
        b.append([f"Line item {i:03d}", owners[i % 5], 100 + i * 10, 200 + i * 5, f"=C{r}+D{r}"])
    b.freeze_panes = "A2"
    b.column_dimensions["A"].width = 22
    wb.defined_names["Q2Check"] = DefinedName("Q2Check", attr_text="Budget!$D$30")
    n = wb.create_sheet("Notes")
    n["A1"] = "Assumptions"
    n["A2"] = "All figures are in thousands."
    wb.save(f"{out}/budget.xlsx")


def deck(out: str) -> None:
    p = Presentation()
    bodies = [
        "Welcome and agenda for the planning review",
        "Revenue grew steadily across all regions this year",
        "Costs stayed flat while headcount rose slightly",
        "Ship the beta in March and collect customer feedback",
        "Risks: vendor delays and a tight hiring market",
        "Next steps: confirm owners and dates by Friday",
    ]
    for i, body in enumerate(bodies, 1):
        s = p.slides.add_slide(p.slide_layouts[1])
        s.shapes.title.text = f"Slide {i} headline"
        s.placeholders[1].text_frame.text = body
        if i == 4:
            tb = s.shapes.add_textbox(Inches(1), Inches(5.6), Inches(6), Inches(0.8))
            tb.name = "Side note"
            tb.text_frame.text = "Owner: Product team"
    p.save(f"{out}/deck.pptx")


if __name__ == "__main__":
    main(sys.argv[1])
    budget(sys.argv[1])
    deck(sys.argv[1])
