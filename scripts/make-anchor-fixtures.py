"""Writes the anchor test fixtures into the directory given as argv[1] (always a temp dir; nothing is written into the repo).
budget.xlsx and deck.pptx come from make-fixtures.py; every other file is that base after one edit made the way an agent
using openpyxl / python-pptx would make it (openpyxl renumbers sheetId by position and does not shift formulas or defined names)."""
import copy
import importlib.util
import os
import sys

import openpyxl
import openpyxl.workbook.defined_name
from pptx import Presentation
from pptx.util import Inches

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("mf", os.path.join(here, "make-fixtures.py"))
mf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mf)


def xlsx_variant(out, name, fn):
    wb = openpyxl.load_workbook(f"{out}/budget.xlsx")
    fn(wb)
    wb.save(f"{out}/{name}")


def pptx_variant(out, name, fn):
    p = Presentation(f"{out}/deck.pptx")
    fn(p)
    p.save(f"{out}/{name}")


def move_slide(p, old, new):
    lst = p.slides._sldIdLst
    items = list(lst)
    el = items[old]
    lst.remove(el)
    lst.insert(new, el)


def insert_slide_before(p, index, title):
    s = p.slides.add_slide(p.slide_layouts[1])
    s.shapes.title.text = title
    s.placeholders[1].text_frame.text = "Inserted by the agent"
    move_slide(p, len(p.slides._sldIdLst) - 1, index)


def delete_slide(p, index):
    lst = p.slides._sldIdLst
    el = list(lst)[index]
    p.part.drop_rel(el.rId)
    lst.remove(el)


def slide_shape(p, index, name_prefix=None, placeholder=None):
    s = p.slides[index]
    if placeholder is not None:
        return s.placeholders[placeholder]
    return next(sh for sh in s.shapes if sh.name.startswith(name_prefix))


def names_book(out):
    """A workbook whose key cell has a defined name; the variant is what a writer that shifts names does."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Rates"
    ws["A1"] = "Tax rate"
    ws["B1"] = 0.2
    wb.defined_names["TaxRate"] = openpyxl.workbook.defined_name.DefinedName("TaxRate", attr_text="Rates!$B$1")
    wb.save(f"{out}/names.xlsx")
    ws.insert_rows(1, 3)
    ws["A4"] = "Sales tax"
    ws["B4"] = 0.25
    wb.defined_names["TaxRate"] = openpyxl.workbook.defined_name.DefinedName("TaxRate", attr_text="Rates!$B$4")
    wb.save(f"{out}/names_moved.xlsx")


def main(out):
    mf.budget(out)
    mf.deck(out)
    names_book(out)
    xlsx_variant(out, "x_rowabove.xlsx", lambda wb: wb["Budget"].insert_rows(5))
    xlsx_variant(out, "x_colleft.xlsx", lambda wb: wb["Budget"].insert_cols(2))
    xlsx_variant(out, "x_renamed.xlsx", lambda wb: setattr(wb["Budget"], "title", "Budget 2026"))
    xlsx_variant(out, "x_reordered.xlsx", lambda wb: wb.move_sheet("Budget", offset=-1))
    xlsx_variant(out, "x_renamed_reordered.xlsx", lambda wb: (setattr(wb["Budget"], "title", "Spend"), wb.move_sheet("Spend", offset=-1)))
    xlsx_variant(out, "x_changed.xlsx", lambda wb: wb["Budget"].__setitem__("D30", 9999))
    xlsx_variant(out, "x_rowabove_changed.xlsx", lambda wb: (wb["Budget"].insert_rows(5), wb["Budget"].__setitem__("D31", 9999)))
    # the commented cell is edited in place AND an unrelated cell elsewhere now holds the old text: the edit must not be stolen
    xlsx_variant(out, "x_changed_dup.xlsx", lambda wb: (wb["Budget"].__setitem__("D30", 9999), wb["Budget"].__setitem__("G5", 345)))
    xlsx_variant(out, "x_rowdeleted.xlsx", lambda wb: wb["Budget"].delete_rows(30))
    xlsx_variant(out, "x_colleft_changed.xlsx", lambda wb: (wb["Budget"].insert_cols(2), wb["Budget"].__setitem__("E30", 9999)))
    xlsx_variant(out, "x_sheetdeleted.xlsx", lambda wb: wb.remove(wb["Budget"]))

    pptx_variant(out, "p_reordered.pptx", lambda p: move_slide(p, 3, 0))
    pptx_variant(out, "p_inserted.pptx", lambda p: insert_slide_before(p, 3, "New slide"))
    pptx_variant(out, "p_textchanged.pptx", lambda p: setattr(slide_shape(p, 3, placeholder=1).text_frame.paragraphs[0].runs[0], "text", "Ship the release in April and gather user input"))
    pptx_variant(out, "p_shapedeleted.pptx", lambda p: slide_shape(p, 3, name_prefix="Side note")._element.getparent().remove(slide_shape(p, 3, name_prefix="Side note")._element))
    pptx_variant(out, "p_slidedeleted.pptx", lambda p: delete_slide(p, 3))
    pptx_variant(out, "p_inserted_changed.pptx", lambda p: (insert_slide_before(p, 3, "New slide"), setattr(slide_shape(p, 4, placeholder=1).text_frame.paragraphs[0].runs[0], "text", "Ship the release in April and gather user input")))


if __name__ == "__main__":
    main(sys.argv[1])
