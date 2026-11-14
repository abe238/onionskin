# M4 spike tool: LibreOffice Accept All / Reject All / record-changes harness (docs/contracts/tracked-changes.md).
# Runs inside LibreOffice, headless and in the foreground, from a PRIVATE profile (never the user's):
#   P=<tempdir>/lo-profile; soffice -env:UserInstallation=file://$P --headless --convert-to pdf --outdir <tempdir> <any.docx>  # creates the profile
#   mkdir -p $P/user/Scripts/python && cp scripts/tracked-spike/lo-accept-reject.py $P/user/Scripts/python/spike.py
#   SPIKE_JOB=<jobs.json> soffice -env:UserInstallation=file://$P --headless --norestore 'vnd.sun.star.script:spike.py$main?language=Python&location=user'
# jobs.json: [{"op": "accept"|"reject", "in": abs.docx, "out": abs.docx}, {"op": "record", "in", "out", "edits": [...]}].
# Results (redlines before/after, paragraph styles and text) go to <jobs.json>.out.json; LibreOffice quits at the end.
import json, os, traceback
import uno
from com.sun.star.beans import PropertyValue

def pv(n, v):
    p = PropertyValue(); p.Name = n; p.Value = v; return p

def url(p): return uno.systemPathToFileUrl(p)

def redlines(doc):
    out = []
    e = doc.getRedlines().createEnumeration()
    while e.hasMoreElements():
        r = e.nextElement()
        try:
            out.append({"type": r.getPropertyValue("RedlineType"), "author": r.getPropertyValue("RedlineAuthor")})
        except Exception as ex:
            out.append({"err": str(ex)})
    return out

def para_list(doc):
    res = []
    e = doc.getText().createEnumeration()
    while e.hasMoreElements():
        el = e.nextElement()
        if el.supportsService("com.sun.star.text.Paragraph"):
            res.append((el.ParaStyleName, el.getString()))
        else:
            res.append(("<table>", ""))
    return res

def main(*args):
    ctx = uno.getComponentContext()
    smgr = ctx.ServiceManager
    desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
    disp = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)
    job = os.environ["SPIKE_JOB"]
    results = []
    for j in json.load(open(job)):
        r = {"job": j}
        try:
            doc = desktop.loadComponentFromURL(url(j["in"]), "_blank", 0, (pv("Hidden", True),))
            r["before"] = redlines(doc)
            frame = doc.getCurrentController().getFrame()
            if j["op"] == "accept":
                disp.executeDispatch(frame, ".uno:AcceptAllTrackedChanges", "", 0, ())
            elif j["op"] == "reject":
                disp.executeDispatch(frame, ".uno:RejectAllTrackedChanges", "", 0, ())
            elif j["op"] == "record":
                doc.setPropertyValue("RecordChanges", True)
                text = doc.getText()
                for ed in j["edits"]:
                    if ed["kind"] == "replace":
                        sd = doc.createSearchDescriptor(); sd.SearchString = ed["find"]
                        found = doc.findFirst(sd); found.setString(ed["with"])
                    elif ed["kind"] == "insert_after_para":
                        # insert a paragraph break + text at the end of paragraph n (0-based body paragraph index, tables skipped)
                        e = text.createEnumeration(); k = -1
                        while e.hasMoreElements():
                            el = e.nextElement()
                            if el.supportsService("com.sun.star.text.Paragraph"):
                                k += 1
                                if k == ed["para"]:
                                    cur = text.createTextCursorByRange(el.getEnd())
                                    text.insertControlCharacter(cur, 0, False)  # PARAGRAPH_BREAK
                                    cur.setPropertyValue("ParaStyleName", ed["style"])
                                    text.insertString(cur, ed["text"], False)
                                    break
                    elif ed["kind"] == "delete_para":
                        e = text.createEnumeration(); k = -1; prev = None
                        while e.hasMoreElements():
                            el = e.nextElement()
                            if el.supportsService("com.sun.star.text.Paragraph"):
                                k += 1
                                if k == ed["para"]:
                                    cur = text.createTextCursorByRange(el.getStart())
                                    cur.gotoEndOfParagraph(True); cur.goRight(1, True)  # text plus its paragraph mark
                                    cur.setString("")
                                    break
                    elif ed["kind"] == "cell":
                        cell = doc.getTextTables().getByIndex(0).getCellByName(ed["cell"])
                        sd = cell.createSearchDescriptor() if hasattr(cell, "createSearchDescriptor") else None
                        c = cell.createTextCursor(); c.gotoStart(False); c.gotoEnd(True); c.setString(ed["text"])
            r["after"] = redlines(doc)
            r["paras"] = para_list(doc)
            doc.storeToURL(url(j["out"]), (pv("FilterName", "MS Word 2007 XML"),))
            doc.close(True)
            r["ok"] = True
        except Exception:
            r["error"] = traceback.format_exc()
        results.append(r)
    json.dump(results, open(job + ".out.json", "w"), indent=1)
    desktop.terminate()
