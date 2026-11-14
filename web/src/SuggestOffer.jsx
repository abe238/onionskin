import React, { useEffect, useRef, useState } from "react";
import { api, store } from "./lib.js";
import { OFFER, WORDS, offerDone } from "./suggest.js";

const KEY = "onionskin.suggestOffer"; // "no" once the person said "No thanks" (per browser; the page works without storage)
const POLL_MS = 500;
const keep = (e) => e.preventDefault(); // a tap must not move the focus out of the text box
const AGAIN = ["failed", "model_not_ready"]; // a second try can help; for every other reason it would say the same

/**
 * The one-time offer in the stamp row of the Quick ask box (Word and PowerPoint only), until the person says "No thanks". One tap on "Turn on" starts
 * the setup (POST /api/setup-rewriter: one background job on the server that checks Apple's built-in model on this Mac and tries one sentence; nothing
 * is downloaded); this page asks for its status until it ends, the same pattern as the deeper checks. `unavailable` = {code, line} when the bootstrap says
 * Apple's model gives no quick fix on this Mac: the line replaces the offer and "No thanks" is all there is to press. `on` = quick fixes are on;
 * `onOn()` tells the page when a setup this offer started has finished; `tasks` = the stamps that show a suggestion first (the bootstrap).
 */
export function SuggestOffer({ format, on, onOn, tasks, unavailable }) {
  const [step, setStep] = useState(unavailable?.line ? "unavailable" : "offer"); // offer | unavailable | working | done | failed
  const [fail, setFail] = useState({ line: unavailable?.line ?? OFFER.failed, again: !unavailable || AGAIN.includes(unavailable.code) });
  const [gone, setGone] = useState(() => store.get("localStorage", KEY) === "no");
  const started = useRef(false); // this offer ran a setup (so "done" is shown instead of nothing)
  const alive = useRef(true);
  const timer = useRef(null);

  const read = async () => {
    let next;
    try {
      next = await api("/api/setup-rewriter");
    } catch {
      next = { state: "failed", reason: "failed" };
    }
    if (!alive.current) return;
    clearTimeout(timer.current);
    if (next.state === "working") {
      started.current = true;
      setStep("working");
      timer.current = setTimeout(read, POLL_MS);
    } else if (next.state === "on") {
      if (started.current) {
        setStep("done");
        onOn?.();
      }
    } else if (next.state === "failed") {
      const known = next.reason !== "failed" && typeof next.detail === "string" && next.detail;
      setFail({ line: known ? next.detail : OFFER.failed, again: AGAIN.includes(next.reason) });
      setStep(known ? "unavailable" : "failed");
    } else if (started.current) {
      setStep("offer");
    }
  };
  useEffect(() => {
    alive.current = true;
    if (!on) read(); // a setup that was already running (the box was closed and opened again) shows as working
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const go = async () => {
    started.current = true;
    setStep("working");
    try {
      await api("/api/setup-rewriter", { method: "POST", body: {} });
    } catch {
      if (alive.current) {
        setFail({ line: OFFER.failed, again: true });
        setStep("failed");
      }
      return;
    }
    read();
  };
  const dismiss = () => {
    store.set("localStorage", KEY, "no");
    setGone(true);
    setStep("offer");
  };

  if (format !== "docx" && format !== "pptx") return null;
  if (on && step !== "done") return null;
  if (gone && step !== "done" && step !== "working") return null;

  const no = (
    <button type="button" className="btn sm quiet" data-testid="suggest-offer-no" onMouseDown={keep} onClick={dismiss}>
      {OFFER.no}
    </button>
  );
  return (
    <div className="qsg-offer" data-testid="suggest-offer" data-step={step}>
      {step === "offer" && (
        <>
          <p>{OFFER.line}</p>
          <div className="qsg-actions">
            <button type="button" className="btn sm primary" data-testid="suggest-offer-go" onMouseDown={keep} onClick={go}>
              {OFFER.turnOn}
            </button>
            {no}
          </div>
        </>
      )}
      {step === "working" && (
        <p className="qsg-wait" role="status" data-testid="suggest-offer-working">
          <span className="spinner" aria-hidden="true" />
          {OFFER.working}
        </p>
      )}
      {step === "done" && (
        <p role="status" data-testid="suggest-offer-done">
          {offerDone(tasks)}
        </p>
      )}
      {(step === "unavailable" || step === "failed") && (
        <>
          <p role={step === "failed" ? "alert" : "status"} data-testid={step === "failed" ? "suggest-offer-failed" : "suggest-offer-unavailable"}>
            {fail.line}
          </p>
          <div className="qsg-actions">
            {fail.again && (
              <button type="button" className="btn sm" data-testid="suggest-offer-retry" onMouseDown={keep} onClick={go}>
                {WORDS.retry}
              </button>
            )}
            {no}
          </div>
        </>
      )}
    </div>
  );
}
