// The words of the demo-docx scenario, in one place: the user script types them, and the recorder and its scan accept only these.
// `letter` is the text of welcome.docx paragraph by paragraph (scripts/real-run/make-fixtures.py makes the file; test/demo-record.test.js
// checks the two agree). The file's parts are byte-stable (only the ZIP's time stamps change), so scan.mjs also pins each part by hash.
export const DEMO = Object.freeze({
  scenario: "demo-docx",
  comments: Object.freeze([
    Object.freeze({ on: "Welcome to Maple Court", text: "Cut the long ending of this sentence." }),
    Object.freeze({ on: "Trash and recycling", text: "Shorten this sentence." }),
    Object.freeze({ on: "If you have any questions", text: "Make this sound friendlier." }),
  ]),
  overall: "Call the front office the Welcome Desk everywhere.",
  letter: Object.freeze([
    "Dear new neighbor,",
    "Welcome to Maple Court. We are delighted that you have decided to join our community, and we hope that you will feel at home here very quickly.",
    "Trash and recycling are collected every Tuesday morning, and bins should be placed at the curb by seven o'clock in the evening before pickup, so that the crew can reach them.",
    "If you have any questions about the building, you should contact the front office, which is open on weekdays from nine until five.",
    "Our front office team looks forward to meeting you at the next coffee morning in the lobby.",
    "Warm regards,",
    "The Maple Court Team",
  ]),
});
