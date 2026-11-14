// The product name and CLI binary name live here only. Rename by editing this file (and package.json "bin").
export const PRODUCT = {
  name: "Onionskin",
  bin: "onionskin",
  stateDirName: ".onionskin",
  envPrefix: "ONIONSKIN",
};


export const SERVER_PROTOCOL = 5; // 2: session.stage, reply, compact polls, /cli/batch-file, stop ends waiting polls; 3: question cards (/api/answer, results "asked"); 4: quick, review and suggestion routes, local history kind, merge in every format (/api/merge edits, /cli/agent-write ops), /api/export-tracked; 5: "Build my voice guide" (/api/voice/build, /api/voice/draft/discard, done takes voice_draft)
export const FORMATS = {
  docx: { main: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", part: "/word/document.xml" },
  xlsx: { main: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", part: "/xl/workbook.xml" },
  pptx: { main: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", part: "/ppt/presentation.xml" },
};
export const REFUSED_EXTENSIONS = new Set([".docm", ".xlsm", ".pptm"]);
export const env = (suffix, fallback) => process.env[`${PRODUCT.envPrefix}_${suffix}`] ?? fallback;

/** The largest document that is opened, sent, written or checked. Enforced by size BEFORE the bytes are read. */
export const MAX_DOC_BYTES = 200 * 1024 * 1024;
