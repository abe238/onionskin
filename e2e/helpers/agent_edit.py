"""Simulated agent: edits a .docx / .xlsx / .pptx the way an agent using python-docx / openpyxl / python-pptx would.
DOCX  FILE insert-before TARGET_PREFIX NEW_TEXT   -> new paragraph above the paragraph starting with TARGET_PREFIX
      FILE replace OLD NEW [PREFIX]                -> OLD -> NEW inside the first paragraph (starting with PREFIX) that contains it
      FILE delete PREFIX                           -> removes the first paragraph starting with PREFIX
      FILE bold PREFIX                             -> makes every run of the first paragraph starting with PREFIX bold (formatting only)
XLSX  FILE xlsx-insert-row SHEET AT                -> inserts an empty row at AT (1-based); openpyxl does not shift formulas or defined names
      FILE xlsx-set SHEET CELL VALUE               -> sets a cell (numbers stay numbers)
      FILE xlsx-delete-row SHEET AT
PPTX  FILE pptx-insert-slide-before INDEX TITLE    -> a new slide before slide INDEX (0-based)
      FILE pptx-set-text SLIDE_INDEX NAME_PREFIX TEXT   -> sets the first paragraph's first run of the shape whose name starts with NAME_PREFIX
      FILE pptx-delete-shape SLIDE_INDEX NAME_PREFIX"""
import sys

path, op = sys.argv[1], sys.argv[2]


def docx_edit():
    from docx import Document

    d = Document(path)
    if op == "insert-before":
        prefix, text = sys.argv[3], sys.argv[4]
        target = next(p for p in d.paragraphs if p.text.startswith(prefix))
        target.insert_paragraph_before(text)
    elif op == "replace":
        # replace OLD with NEW inside the first paragraph that starts with PREFIX (argv[5]) and contains OLD
        old, new = sys.argv[3], sys.argv[4]
        prefix = sys.argv[5] if len(sys.argv) > 5 else ""
        for p in d.paragraphs:
            if p.text.startswith(prefix) and old in p.text:
                for r in p.runs:
                    if old in r.text:
                        r.text = r.text.replace(old, new)
                        break
                else:
                    p.text = p.text.replace(old, new)
                break
        else:
            raise SystemExit("text not found")
    elif op == "bold":
        target = next(p for p in d.paragraphs if p.text.startswith(sys.argv[3]))
        for r in target.runs:
            r.bold = True
    elif op == "delete":
        target = next(p for p in d.paragraphs if p.text.startswith(sys.argv[3]))
        target._element.getparent().remove(target._element)
    else:
        raise SystemExit("unknown op")
    d.save(path)


def xlsx_edit():
    import openpyxl

    wb = openpyxl.load_workbook(path)
    ws = wb[sys.argv[3]]
    if op == "xlsx-insert-row":
        ws.insert_rows(int(sys.argv[4]))
    elif op == "xlsx-delete-row":
        ws.delete_rows(int(sys.argv[4]))
    elif op == "xlsx-set":
        v = sys.argv[5]
        try:
            v = float(v) if "." in v else int(v)
        except ValueError:
            pass
        ws[sys.argv[4]] = v
    else:
        raise SystemExit("unknown op")
    wb.save(path)


def pptx_edit():
    from pptx import Presentation

    p = Presentation(path)
    lst = p.slides._sldIdLst
    if op == "pptx-insert-slide-before":
        idx, title = int(sys.argv[3]), sys.argv[4]
        s = p.slides.add_slide(p.slide_layouts[1])
        s.shapes.title.text = title
        s.placeholders[1].text_frame.text = "Inserted by the agent"
        el = list(lst)[-1]
        lst.remove(el)
        lst.insert(idx, el)
    else:
        slide = p.slides[int(sys.argv[3])]
        shape = next(sh for sh in slide.shapes if sh.name.startswith(sys.argv[4]))
        if op == "pptx-set-text":
            shape.text_frame.paragraphs[0].runs[0].text = sys.argv[5]
        elif op == "pptx-delete-shape":
            shape._element.getparent().remove(shape._element)
        else:
            raise SystemExit("unknown op")
    p.save(path)


if path.endswith(".xlsx"):
    xlsx_edit()
elif path.endswith(".pptx"):
    pptx_edit()
else:
    docx_edit()
