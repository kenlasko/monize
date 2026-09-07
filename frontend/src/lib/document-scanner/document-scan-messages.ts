import { loadEngine } from './opencv-engine';
import {
  detectDocument,
  enhance,
  limitSize,
  warpToQuad,
} from './document-scan-pipeline';
import { assessCapture } from './document-scan-quality';
import type {
  ScannerRequest,
  ScannerResponse,
  ScanResult,
} from './document-scan.types';

/**
 * The worker's dispatcher, as an ordinary function.
 *
 * The worker file itself is three lines of `postMessage` plumbing that no test
 * environment can run, so everything it decides lives here instead: which
 * pipeline steps a request runs, what a failure turns into, and how the request
 * id is carried back. The split is what makes the worker's behaviour testable
 * without a worker.
 */
export async function handleScanMessage(
  request: ScannerRequest,
): Promise<ScannerResponse> {
  try {
    const cv = await loadEngine();

    if (request.kind === 'scan') {
      const { quad, found } = detectDocument(cv, request.image);
      const warped = warpToQuad(cv, request.image, quad);
      const enhanced = limitSize(cv, enhance(cv, warped));
      const result: ScanResult = {
        documentFound: found,
        quad,
        enhanced,
        warnings: assessCapture(cv, request.image, quad, found, enhanced),
      };
      return { kind: 'result', requestId: request.requestId, result };
    }

    // A re-warp follows the user overruling the detection, so it does not
    // detect again -- and it reports `documentFound: true` because the corners
    // are now the user's own, not a guess that might have failed.
    const warped = warpToQuad(
      cv,
      request.image,
      request.quad,
      request.rotation,
    );
    const enhanced = limitSize(cv, enhance(cv, warped));
    const result: ScanResult = {
      documentFound: true,
      quad: request.quad,
      enhanced,
      warnings: assessCapture(cv, request.image, request.quad, true, enhanced),
    };
    return { kind: 'result', requestId: request.requestId, result };
  } catch (error) {
    // The id travels even on failure: the caller matches replies to requests,
    // and an error with no id is a reply it can only drop (`I6`).
    return {
      kind: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
