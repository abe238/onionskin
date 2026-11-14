"""Writes the synthetic documents for the launch media (scripts/demo/launch-media.mjs) into the folder given as argv[1].
Everything here is invented: no real company, person or figure.
quarterly-update.docx: a one-page update with a title, three short sections and a small table.
quarterly-numbers.xlsx: one sheet of product prices and revenue formulas.
q3-review.pptx: three slides drawn from plain shapes."""
import sys
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt, RGBColor, Inches
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from pptx import Presentation
from pptx.dml.color import RGBColor as PRGB
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches as PIn, Pt as PPt

NAVY = RGBColor(0x1F, 0x2A, 0x44)


def docx(out: str) -> None:
    d = Document()
    for s in d.sections:
        s.left_margin = s.right_margin = Inches(1)
        s.top_margin = s.bottom_margin = Inches(0.6)
    st = d.styles["Normal"]
    st.font.name = "Calibri"
    st.font.size = Pt(11)
    st.paragraph_format.space_after = Pt(6)
    for name, size in (("Heading 1", 22), ("Heading 2", 13)):
        h = d.styles[name]
        h.font.name = "Calibri"
        h.font.size = Pt(size)
        h.font.bold = True
        h.font.color.rgb = NAVY
    d.styles["Heading 1"].paragraph_format.space_before = Pt(0)
    d.add_heading("Quarterly Update: Q3 2026", level=1)
    sub = d.add_paragraph("Prepared by the Operations team for the leadership group. October 2026.")
    sub.runs[0].italic = True
    d.add_heading("Highlights", level=2)
    d.add_paragraph(
        "Revenue grew to $1.39 million in the third quarter, which was well above the plan that the leadership team approved in July after a long and careful review of the pipeline. "
        "We also welcomed 57 new customers, and on-time delivery improved from 91 percent to 94 percent."
    )
    d.add_heading("Challenges", level=2)
    d.add_paragraph("Supplier delays in August pushed several orders into September.")
    d.add_paragraph("We expect to recieve the final signed contracts from both logistics partners by the end of November.")
    d.add_heading("Next quarter", level=2)
    d.add_paragraph("In the fourth quarter we will open the second warehouse, hire two dispatchers, and finish the new ordering page.")
    t = d.add_table(rows=4, cols=4)
    t.style = "Light Grid Accent 1"
    rows = [("Metric", "Q2", "Q3", "Change"), ("Revenue ($K)", "1,240", "1,385", "+11.7%"), ("New customers", "48", "57", "+9"), ("On-time delivery", "91%", "94%", "+3 pts")]
    for i, r in enumerate(rows):
        for j, v in enumerate(r):
            c = t.cell(i, j)
            c.text = v
            if j:
                c.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT
    d.save(f"{out}/quarterly-update.docx")


def xlsx(out: str) -> None:
    wb = openpyxl.Workbook()
    s = wb.active
    s.title = "Q3 Sales"
    s["A1"] = "Q3 2026 product sales"
    s["A1"].font = Font(bold=True, size=14)
    head = ["Product", "Units", "Price", "Revenue"]
    for j, v in enumerate(head):
        c = s.cell(row=3, column=j + 1, value=v)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="1F2A44")
        c.alignment = Alignment(horizontal="left" if j == 0 else "right")
    data = [("Standard crate", 420, 24.0), ("Large crate", 265, 38.5), ("Pallet wrap", 810, 9.25), ("Label rolls", 530, 14.0), ("Strapping kit", 195, 31.0)]
    for i, (p, u, pr) in enumerate(data):
        r = 4 + i
        s.cell(row=r, column=1, value=p)
        s.cell(row=r, column=2, value=u)
        s.cell(row=r, column=3, value=pr).number_format = "$#,##0.00"
        s.cell(row=r, column=4, value=f"=B{r}*C{r}").number_format = "$#,##0.00"
    s["A9"] = "Total"
    s["A9"].font = Font(bold=True)
    s["D9"] = "=SUM(D4:D8)"
    s["D9"].font = Font(bold=True)
    s["D9"].number_format = "$#,##0.00"
    for col, w in zip("ABCD", (22, 12, 12, 16)):
        s.column_dimensions[col].width = w
    wb.save(f"{out}/quarterly-numbers.xlsx")


def pptx(out: str) -> None:
    p = Presentation()
    p.slide_width, p.slide_height = PIn(13.333), PIn(7.5)
    blank = p.slide_layouts[6]

    def box(slide, x, y, w, h, text, size, bold=False, color=(0x1F, 0x2A, 0x44), name=None):
        tb = slide.shapes.add_textbox(PIn(x), PIn(y), PIn(w), PIn(h))
        if name:
            tb.name = name
        tf = tb.text_frame
        tf.word_wrap = True
        lines = text if isinstance(text, list) else [text]
        for i, line in enumerate(lines):
            para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            run = para.add_run()
            run.text = line
            run.font.size = PPt(size)
            run.font.bold = bold
            run.font.name = "Calibri"
            run.font.color.rgb = PRGB(*color)
            para.space_after = PPt(10)
        return tb

    def bar(slide):
        r = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, p.slide_width, PIn(0.35))
        r.fill.solid()
        r.fill.fore_color.rgb = PRGB(0x1F, 0x2A, 0x44)
        r.line.fill.background()
        tf = r.text_frame
        tf.margin_top = tf.margin_bottom = 0
        tf.margin_left = PIn(0.9)
        run = tf.paragraphs[0].add_run()
        run.text = "Operations team  |  Q3 2026"
        run.font.size = PPt(11)
        run.font.name = "Calibri"
        run.font.color.rgb = PRGB(0xFF, 0xFF, 0xFF)
        tf.paragraphs[0].alignment = PP_ALIGN.LEFT

    s1 = p.slides.add_slide(blank)
    bar(s1)
    box(s1, 0.9, 2.3, 11.5, 1.4, "Q3 2026 Review", 48, True, name="Title")
    box(s1, 0.9, 3.8, 11.5, 0.8, "Operations team update for the leadership group", 22, color=(0x55, 0x5F, 0x73), name="Subtitle")
    s2 = p.slides.add_slide(blank)
    bar(s2)
    box(s2, 0.9, 0.8, 11.5, 1.0, "Third quarter highlights", 36, True, name="Title")
    box(s2, 0.9, 2.0, 11.5, 4.2, ["Revenue of $1.39 million, up 11.7 percent on Q2", "57 new customers, 9 more than last quarter", "On-time delivery at 94 percent, up from 91 percent", "Supplier delays in August were absorbed by September"], 24, name="Body")
    s3 = p.slides.add_slide(blank)
    bar(s3)
    box(s3, 0.9, 0.8, 11.5, 1.0, "Next quarter", 36, True, name="Title")
    box(s3, 0.9, 2.0, 11.5, 4.2, ["Open the second warehouse", "Hire two dispatchers", "Finish the new ordering page"], 24, name="Body")
    p.save(f"{out}/q3-review.pptx")


if __name__ == "__main__":
    docx(sys.argv[1])
    xlsx(sys.argv[1])
    pptx(sys.argv[1])
