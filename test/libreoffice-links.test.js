import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, test } from "node:test";
import { buildZip, docxBytes, tmpdir } from "./helpers/zipbuild.js";
import { openZip } from "../src/zip.js";

// Finding 17: `done` converts the user's untrusted files with LibreOffice. Does a headless conversion fetch the links a hostile file carries?
// This starts a listener on 127.0.0.1, converts a DOCX full of references to it with the same command line scripts/checker/check.py uses
// (private throwaway profile, headless), and fails if the listener sees a single request.
const SOFFICE = process.env.ONIONSKIN_SOFFICE || "/Applications/LibreOffice.app/Contents/MacOS/soffice";
const root = tmpdir("da-lo-");
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("LibreOffice does not fetch linked images, hyperlinks, fields, linked OLE objects or an attached template while converting", { skip: !fs.existsSync(SOFFICE) && `LibreOffice not found at ${SOFFICE} (set ONIONSKIN_SOFFICE)` }, async () => {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const field = (instr) => `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>x</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
    const body =
      '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="l"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="l.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:link="rId90"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
      '<w:p><w:hyperlink r:id="rId91"><w:r><w:t>a link</w:t></w:r></w:hyperlink></w:p>' +
      field(`INCLUDEPICTURE "${base}/includepicture.png" \\d`) +
      field(`INCLUDETEXT "${base}/includetext.docx"`) +
      '<w:p><w:r><w:object w:dxaOrig="1000" w:dyaOrig="1000"><v:shape id="_x0000_i1025" type="#_x0000_t75" style="width:50pt;height:50pt" xmlns:v="urn:schemas-microsoft-com:vml"/><o:OLEObject xmlns:o="urn:schemas-microsoft-com:office:office" Type="Link" ProgID="Excel.Sheet.12" ShapeID="_x0000_i1025" DrawAspect="Content" r:id="rId92" UpdateMode="Always"/></w:object></w:r></w:p>';
    const z = openZip(docxBytes(["Probe paragraph."]));
    const files = Object.fromEntries(z.names.map((n) => [n, z.read(n)]));
    files["word/document.xml"] = z.readText("word/document.xml").replace("<w:document ", `<w:document xmlns:r="${REL}" `).replace("</w:body>", `${body}</w:body>`);
    const ext = (id, type, target) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${base}/${target}" TargetMode="External"/>`;
    files["word/_rels/document.xml.rels"] = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ext("rId90", "image", "linked-image.png")}${ext("rId91", "hyperlink", "hyperlink")}${ext("rId92", "oleObject", "linked-ole.xlsx")}</Relationships>`;
    files["word/settings.xml"] = `<?xml version="1.0" encoding="UTF-8"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${REL}"><w:attachedTemplate r:id="rId80"/></w:settings>`;
    files["word/_rels/settings.xml.rels"] = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ext("rId80", "attachedTemplate", "template.dotm")}</Relationships>`;
    files["_rels/.rels"] = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`; // the toy zips use a placeholder type; LibreOffice wants the real one
    files["[Content_Types].xml"] = z
      .readText("[Content_Types].xml")
      .replace("<Default ", '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Default ');
    const file = path.join(root, "probe.docx");
    fs.writeFileSync(file, buildZip(files));
    const profile = path.join(root, "profile");
    // the same invocation as scripts/checker/check.py soffice_convert, run asynchronously so this process can answer the listener
    const convert = (fmt) =>
      new Promise((resolve, reject) => {
        const p = spawn(SOFFICE, [`-env:UserInstallation=file://${profile}`, "--headless", "--norestore", "--convert-to", fmt, "--outdir", root, file], { stdio: "ignore" });
        const t = setTimeout(() => (p.kill("SIGKILL"), reject(new Error("soffice timed out"))), 120_000);
        p.on("exit", (code) => (clearTimeout(t), code === 0 ? resolve() : reject(new Error(`soffice exit ${code}`))));
      });
    await convert("pdf");
    await convert("odt");
    // the control: LibreOffice did read the references (they are in its own export), it just did not follow them
    const odt = openZip(fs.readFileSync(path.join(root, "probe.odt"))).readText("content.xml");
    assert.ok(odt.includes(`${base}/linked-image.png`) && odt.includes(`${base}/hyperlink`), "the file's links were parsed");
    await new Promise((r) => setTimeout(r, 1500)); // a late fetch would land here
    assert.ok(fs.existsSync(path.join(root, "probe.pdf")), "the conversion itself worked");
    assert.deepEqual(hits, [], "LibreOffice contacted the listener");
  } finally {
    srv.close();
    srv.closeAllConnections?.();
  }
});
