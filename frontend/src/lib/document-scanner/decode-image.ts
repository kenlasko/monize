import type { RawImage } from './document-scan.types';

/**
 * Turning a picked `File` into pixels, and pixels back into a file.
 *
 * Both directions live on the main thread because both need a canvas. The
 * important part is the ORIENTATION: a phone writes the sensor's pixels and an
 * EXIF tag saying which way up they were, so a decode that ignores the tag
 * hands the pipeline a sideways document and every corner it finds is right for
 * an image nobody will ever see. `imageOrientation: 'from-image'` applies the
 * tag during decode, which is why the worker only ever sees upright pixels and
 * has no orientation logic of its own.
 */

/** Quality of the JPEG the scan is uploaded as. */
export const OUTPUT_JPEG_QUALITY = 0.85;

/** The MIME type and extension an enhanced scan is stored under. */
export const OUTPUT_MIME = 'image/jpeg';

/** Decode a picked image file to upright RGBA pixels. */
export async function decodeImageFile(file: Blob): Promise<RawImage> {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image',
  });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not read the image');
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
    };
  } finally {
    bitmap.close();
  }
}

/** Render pixels to a canvas, for preview or for encoding. */
export function toCanvas(image: RawImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not draw the image');
  // Copied into a plain ArrayBuffer-backed view: `ImageData` will not accept a
  // buffer that might be shared, and a transferred worker result is typed as
  // possibly being one.
  const pixels = new Uint8ClampedArray(image.data.length);
  pixels.set(image.data);
  context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
  return canvas;
}

/**
 * Encode pixels as the JPEG that will be uploaded.
 *
 * This exact blob is what the preview showed and what the upload sends -- the
 * image is never re-rendered between approving it and storing it, which is what
 * makes "the file you saw is the file you got" true rather than likely (`I3`).
 */
export async function encodeScan(
  image: RawImage,
  filename: string,
): Promise<File> {
  const canvas = toCanvas(image);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, OUTPUT_MIME, OUTPUT_JPEG_QUALITY),
  );
  if (!blob) throw new Error('Could not encode the scanned document');
  return new File([blob], filename, { type: OUTPUT_MIME });
}

/**
 * The filename an enhanced scan is stored under: the original's stem with a
 * `-scan` suffix, so the two halves of a pair read as a pair in any list that
 * shows both.
 */
export function scanFilename(originalName: string): string {
  const trimmed = (originalName || 'document').replace(/\.[^./\\]+$/, '');
  const stem = trimmed.length > 0 ? trimmed : 'document';
  return `${stem}-scan.jpg`;
}
