"""Writes fixtures for the apply tests into the directory given as argv[1] (always a temp dir).
fields.docx: a heading, plain paragraphs (two with identical text), and a paragraph with a complex field (protected).
tables.xlsx: sheet Data (values, a formula, a merged range), sheet Tbl with an Excel table (structural edits must be refused by a current engine).
shapes.pptx: one slide with a title and a two-paragraph body."""
import sys
from docx import Document
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls
import openpyxl
from openpyxl.worksheet.table import Table
from pptx import Presentation


def docx(out):
    d = Document()
    d.add_heading("Field report", level=1)
    d.add_paragraph("The committee meets every Tuesday morning to review open items.")
    d.add_paragraph("Same words twice.")
    d.add_paragraph("Same words twice.")
    p = d.add_paragraph("Total pages: ")
    p._p.append(parse_xml(f'<w:r {nsdecls("w")}><w:fldChar w:fldCharType="begin"/></w:r>'))
    p._p.append(parse_xml(f'<w:r {nsdecls("w")}><w:instrText xml:space="preserve"> NUMWORDS </w:instrText></w:r>'))
    p._p.append(parse_xml(f'<w:r {nsdecls("w")}><w:fldChar w:fldCharType="separate"/></w:r>'))
    p._p.append(parse_xml(f'<w:r {nsdecls("w")}><w:t>42</w:t></w:r>'))
    p._p.append(parse_xml(f'<w:r {nsdecls("w")}><w:fldChar w:fldCharType="end"/></w:r>'))
    d.add_paragraph("Closing paragraph after the field.")
    d.save(f"{out}/fields.docx")


def xlsx(out):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Data"
    ws.append(["Item", "Qty", "Price", "Total"])
    for i in range(1, 6):
        ws.append([f"Item {i}", i * 3, 2.5 * i, f"=B{i + 1}*C{i + 1}"])
    ws.merge_cells("F1:G1")
    ws["F1"] = "Merged heading"
    t = wb.create_sheet("Tbl")
    t.append(["Name", "Score"])
    for n, s in [("Ann", 3), ("Ben", 5), ("Cy", 8)]:
        t.append([n, s])
    t.add_table(Table(displayName="Scores", ref="A1:B4"))
    wb.save(f"{out}/tables.xlsx")


def pptx(out):
    p = Presentation()
    s = p.slides.add_slide(p.slide_layouts[1])
    s.shapes.title.text = "Launch plan"
    tf = s.placeholders[1].text_frame
    tf.text = "Ship the beta in March"
    tf.add_paragraph().text = "Collect feedback from ten customers"
    p.save(f"{out}/shapes.pptx")


if __name__ == "__main__":
    docx(sys.argv[1])
    xlsx(sys.argv[1])
    pptx(sys.argv[1])
