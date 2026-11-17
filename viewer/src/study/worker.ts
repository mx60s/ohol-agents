// Web Worker: runs the permutation-heavy analyses (about 2 s at n = 400) off the main thread,
// so the live page doesn't freeze every time /api/lives changes. Only imported via new Worker().
import { computeStudy, type StudyRequest, type StudyResult } from "./analysis.ts";

const ctx = self as unknown as { onmessage: ((e: MessageEvent<StudyRequest>) => void) | null; postMessage: (m: StudyResult) => void };
ctx.onmessage = (e) => ctx.postMessage(computeStudy(e.data));
