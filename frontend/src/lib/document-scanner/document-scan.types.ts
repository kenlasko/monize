/**
 * The shapes the document scanner passes between the main thread and its
 * worker. Plain data only: everything here has to survive `postMessage`, so
 * there are no class instances, no functions and no OpenCV types.
 *
 * See `docs/future-plans/document-scanner.md`.
 */

/** One corner of a detected document, in source-image pixels. */
export interface Point {
  x: number;
  y: number;
}

/**
 * A document's four corners, always ordered top-left, top-right,
 * bottom-right, bottom-left. The ordering is what makes a warp reproducible,
 * so it is established once (`orderCorners`) and relied on everywhere after.
 */
export type Quad = readonly [Point, Point, Point, Point];

/** A decoded image, as the worker receives it. */
export interface RawImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, length `width * height * 4`. */
  data: Uint8ClampedArray;
}

/**
 * Something about the capture that the user may want to fix by retaking the
 * photo. Always a warning and never a refusal: information the user meant to
 * keep is worse lost than imperfect (`I5`).
 */
export type QualityWarning = 'blurry' | 'edgesOutsideFrame' | 'lowResolution';

/** What the pipeline found and produced for one photo. */
export interface ScanResult {
  /** Whether a document-shaped quadrilateral was actually detected. */
  documentFound: boolean;
  /** The corners used for the warp -- the detection, or the full frame. */
  quad: Quad;
  /** The enhanced document image. */
  enhanced: RawImage;
  warnings: QualityWarning[];
}

/** Ask the worker to detect a document and enhance it. */
export interface ScanRequest {
  kind: 'scan';
  requestId: number;
  image: RawImage;
}

/**
 * Ask the worker to redo the warp and enhancement for corners the user moved.
 * Detection is not repeated: the user has just overruled it.
 */
export interface RewarpRequest {
  kind: 'rewarp';
  requestId: number;
  image: RawImage;
  quad: Quad;
  /** Quarter turns clockwise to apply after the warp. */
  rotation: 0 | 1 | 2 | 3;
}

export type ScannerRequest = ScanRequest | RewarpRequest;

export interface ScannerSuccess {
  kind: 'result';
  requestId: number;
  result: ScanResult;
}

export interface ScannerFailure {
  kind: 'error';
  requestId: number;
  message: string;
}

export type ScannerResponse = ScannerSuccess | ScannerFailure;
