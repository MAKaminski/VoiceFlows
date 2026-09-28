import { describe, expect, it } from "vitest";
import { alignWords, DEMO_SCRIPT } from "../src/demo.js";

describe("voice demo alignment (ADR 0021)", () => {
  it("uses the transcript's timings when the words line up, and always the SCRIPT's words", () => {
    const heard = [{ word: "send", start: 0.1, end: 0.3 }, { word: "grid", start: 0.3, end: 0.6 }];
    expect(alignWords("SendGrid", heard, 1).map((w) => w.word)).toEqual(["SendGrid"]); // counts differ → spread, script words kept
    const same = [{ word: "cheap", start: 0.2, end: 0.5 }, { word: "value", start: 0.6, end: 0.9 }];
    expect(alignWords("cheap value", same, 1)).toEqual([{ word: "cheap", start: 0.2, end: 0.5 }, { word: "value", start: 0.6, end: 0.9 }]);
  });
  it("the script covers all six views", () => {
    expect(new Set(DEMO_SCRIPT.map((l) => l.view))).toEqual(new Set(["screen", "architecture", "erd", "sequence", "constraints", "cva"]));
  });
});
