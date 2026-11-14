// The server's copy of the built-in stamps' words, from web/src/stamps.js (src/ cannot import the page's source: only web/dist is
// packaged). test/stamp-words.test.js checks that both stay the same. A comment whose words equal one of these was a stamp tap.
export const STAMP_WORDS = {
  shorter: "Make this shorter. Keep the meaning.",
  friendlier: "Make this sound friendlier. Keep the meaning.",
  grammar: "Fix the grammar, spelling and punctuation here. Change nothing else.",
  translate: "Translate this into {language}.",
};
export const BUILT_IN_STAMP_WORDS = Object.values(STAMP_WORDS);
export const STAMP_LANGUAGES = ["Spanish", "French", "German", "Portuguese", "Italian", "Chinese", "Japanese", "Korean"];
