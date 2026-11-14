"""Writes FILE: budget-like workbook that carries a part openpyxl does not keep (a printer settings blob linked from the sheet).
A round trip through openpyxl drops it, which the package check sees as a removed part."""
import io
import sys
import zipfile

import openpyxl

out = sys.argv[1]
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Budget"
ws.append(["Item", "Owner", "Q1", "Q2"])
for i in range(1, 31):
    ws.append([f"Line item {i:03d}", "Ana", 100 + i, 200 + i])
buf = io.BytesIO()
wb.save(buf)
src = zipfile.ZipFile(io.BytesIO(buf.getvalue()))
dst = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)
for item in src.infolist():
    data = src.read(item.filename)
    if item.filename == "[Content_Types].xml":
        data = data.replace(b"<Default ", b'<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/><Default ', 1)
    if item.filename == "xl/worksheets/sheet1.xml":
        data = data.replace(b"</worksheet>", b'<pageSetup xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></worksheet>')
    dst.writestr(item, data)
dst.writestr("xl/worksheets/_rels/sheet1.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="../printerSettings/printerSettings1.bin"/></Relationships>')
dst.writestr("xl/printerSettings/printerSettings1.bin", b"\x00PRINTER" * 64)
dst.close()
