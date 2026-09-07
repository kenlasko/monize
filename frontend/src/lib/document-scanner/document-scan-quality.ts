import type { OpenCv } from './opencv-engine';
import {
  DETECT_MAX_EDGE,
  fitScale,
  touchesFrameEdge,
} from './document-scan-geometry';
import type { Quad, QualityWarning, RawImage } from './document-scan.types';

/**
 * Checks on the capture itself, so a photo that has already lost the
 * information can be retaken rather than repaired.
 *
 * Every result is a WARNING. Nothing here refuses a scan: a blurred receipt the
 * user cannot photograph again is still worth keeping, and a threshold that
 * blocks is a threshold that will one day be wrong about somebody's only copy
 * (`I5`).
 */

/**
 * Variance of the Laplacian below which an image reads as motion-blurred.
 *
 * Measured on the detection-sized working copy so the number means the same
 * thing for a 5 MP phone and a 50 MP one -- variance falls as an image is
 * enlarged, so a threshold applied at native resolution would call every
 * high-resolution photo sharp.
 */
export const BLUR_VARIANCE_THRESHOLD = 100;

/** How close to the frame edge a corner may sit before it reads as cropped. */
export const FRAME_EDGE_MARGIN_RATIO = 0.01;

/** The shortest edge an enhanced document may have and still read cleanly. */
export const MIN_OUTPUT_SHORT_EDGE = 600;

/**
 * The variance of the Laplacian: the standard sharpness proxy.
 *
 * A focused image has strong second derivatives at every glyph edge; a blurred
 * one has almost none, so the spread of the Laplacian collapses.
 */
export function blurVariance(cv: OpenCv, image: RawImage): number {
  const source = new cv.Mat(image.height, image.width, cv.CV_8UC4);
  const gray = new cv.Mat();
  const working = new cv.Mat();
  const laplacian = new cv.Mat();
  const mean = new cv.Mat();
  const stdDev = new cv.Mat();
  try {
    source.data.set(image.data);
    const scale = fitScale(image.width, image.height, DETECT_MAX_EDGE);
    if (scale < 1) {
      cv.resize(
        source,
        working,
        new cv.Size(
          Math.max(1, Math.round(image.width * scale)),
          Math.max(1, Math.round(image.height * scale)),
        ),
        0,
        0,
        cv.INTER_AREA,
      );
    } else {
      source.copyTo(working);
    }
    cv.cvtColor(working, gray, cv.COLOR_RGBA2GRAY);
    cv.Laplacian(gray, laplacian, cv.CV_64F);
    cv.meanStdDev(laplacian, mean, stdDev);
    const sigma = stdDev.doubleAt(0, 0);
    return sigma * sigma;
  } finally {
    for (const mat of [source, gray, working, laplacian, mean, stdDev]) {
      mat.delete();
    }
  }
}

/**
 * Everything worth telling the user about this capture.
 *
 * Order is deliberate: the ones that cost the most information come first, so a
 * dialogue showing only the first warning shows the one most worth retaking
 * for.
 */
export function assessCapture(
  cv: OpenCv,
  image: RawImage,
  quad: Quad,
  documentFound: boolean,
  output: { width: number; height: number },
): QualityWarning[] {
  const warnings: QualityWarning[] = [];

  if (blurVariance(cv, image) < BLUR_VARIANCE_THRESHOLD) {
    warnings.push('blurry');
  }

  // Either nothing document-shaped was found, or what was found runs off the
  // side of the photo -- both mean part of the page is not in the frame.
  const margin = Math.max(image.width, image.height) * FRAME_EDGE_MARGIN_RATIO;
  if (
    !documentFound ||
    touchesFrameEdge(quad, image.width, image.height, margin)
  ) {
    warnings.push('edgesOutsideFrame');
  }

  if (Math.min(output.width, output.height) < MIN_OUTPUT_SHORT_EDGE) {
    warnings.push('lowResolution');
  }

  return warnings;
}
