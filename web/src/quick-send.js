// When the Send button may offer a quick change (src/quick-plan.js): only when the Send would be the note alone, as the local runner's
// `wants` requires. The server checks again with what it holds (a batch waiting, typed edits from an earlier Send).

/** A comment that goes with the next Send: a draft, queued, or sent and still waiting for an agent. Done and declined ones do not. */
export const ridesAlong = (c) => ["draft", "queued", "sent"].includes(c.status);

/**
 * The Send would carry only the note: no comment that goes with it and no typed edit. `dirty` counts too: typing that was undone leaves
 * no listed edit, but the page still sends its document, and a Send with the document goes to the agent.
 */
export const noteAlone = ({ comments, edits, dirty }) => !dirty && edits === 0 && !comments.some(ridesAlong);
