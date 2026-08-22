'use client';

/**
 * Client-side image handling for the menu scanner. Two jobs, both on a canvas,
 * no libraries:
 *   1. Downscale + JPEG-compress so a few menu photos fit the upload. This is
 *      the ONE preprocessing step that actually helps — the vision model reads
 *      imperfect photos fine, so perspective/glare correction would be a lot of
 *      code for little gain (spec §4, "where practical"). EXIF orientation is
 *      applied so a sideways phone photo lands upright.
 *   2. A light quality read — mean brightness and a blur score — to warn about a
 *      clearly bad shot before spending an API call (spec §3). Advisory only:
 *      the user can always Continue Anyway.
 */

export type QualityCode = 'dark' | 'bright' | 'blurry';
export type QualityWarning = { code: QualityCode; message: string };

export type ScannedImage = {
  /** JPEG data URL, downscaled — this is what gets uploaded. */
  dataUrl: string;
  warnings: QualityWarning[];
};

const MAX_EDGE = 1600; // upload size cap (longest edge, px)
const ANALYSIS_EDGE = 320; // small copy the quality read runs on
const JPEG_QUALITY = 0.82;

// Heuristic thresholds over a 0..255 mean luma and a Laplacian-variance focus
// score. Conservative, so only clearly bad shots warn.
// ponytail: fixed thresholds; make them adaptive if false positives show up.
const DARK_BELOW = 55;
const BRIGHT_ABOVE = 205;
const BLUR_BELOW = 60;

function drawScaled(
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxEdge: number,
): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(srcW * scale));
  canvas.height = Math.max(1, Math.round(srcH * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Mean brightness and a Laplacian-variance focus score → warnings. */
function assess(canvas: HTMLCanvasElement): QualityWarning[] {
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  const { width: w, height: h } = canvas;
  const { data } = ctx.getImageData(0, 0, w, h);

  const luma = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    luma[p] = y;
    sum += y;
  }
  const brightness = sum / (w * h);

  // Variance of the Laplacian — the classic focus measure. Low = blurry.
  let lapSum = 0;
  let lapSqSum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - w] - luma[i + w];
      lapSum += lap;
      lapSqSum += lap * lap;
      n++;
    }
  }
  const mean = n ? lapSum / n : 0;
  const variance = n ? lapSqSum / n - mean * mean : 0;
  const focus = Math.sqrt(Math.max(0, variance));

  const warnings: QualityWarning[] = [];
  if (brightness < DARK_BELOW) {
    warnings.push({
      code: 'dark',
      message: 'Lighting is low — move somewhere brighter and try again.',
    });
  } else if (brightness > BRIGHT_ABOVE) {
    warnings.push({
      code: 'bright',
      message: 'Too bright or glare — adjust the angle to reduce reflections.',
    });
  }
  if (focus < BLUR_BELOW) {
    warnings.push({
      code: 'blurry',
      message: 'The image looks blurry — hold steady and capture again.',
    });
  }
  return warnings;
}

async function toBitmap(file: File | Blob): Promise<ImageBitmap> {
  // imageOrientation applies EXIF rotation so a sideways phone photo is upright.
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return createImageBitmap(file);
  }
}

/** Process a picked file into an upload-ready, quality-checked image. */
export async function processFile(file: File | Blob): Promise<ScannedImage> {
  const bitmap = await toBitmap(file);
  try {
    const big = drawScaled(bitmap, bitmap.width, bitmap.height, MAX_EDGE);
    const small = drawScaled(bitmap, bitmap.width, bitmap.height, ANALYSIS_EDGE);
    return {
      dataUrl: big.toDataURL('image/jpeg', JPEG_QUALITY),
      warnings: assess(small),
    };
  } finally {
    bitmap.close();
  }
}

/** Process a captured camera frame (a <video> element) the same way. */
export function processVideoFrame(video: HTMLVideoElement): ScannedImage {
  const w = video.videoWidth;
  const h = video.videoHeight;
  const big = drawScaled(video, w, h, MAX_EDGE);
  const small = drawScaled(video, w, h, ANALYSIS_EDGE);
  return {
    dataUrl: big.toDataURL('image/jpeg', JPEG_QUALITY),
    warnings: assess(small),
  };
}

export const isSupportedType = (file: File) =>
  /^image\/(jpe?g|png|webp)$/.test(file.type);
