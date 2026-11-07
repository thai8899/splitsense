/** Formatting and small UI helpers shared by pages. */

export function money(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

/** Receipt-style amount without a currency symbol: 1234 -> "12.34". */
export function plain(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const PENS = ['--color-pen-1', '--color-pen-2', '--color-pen-3', '--color-pen-4', '--color-pen-5', '--color-pen-6', '--color-pen-7', '--color-pen-8'];

/** Each participant keeps the same highlighter colour everywhere in the app. */
export function penFor(participants: string[], name: string): string {
  const index = Math.max(0, participants.indexOf(name));
  return `var(${PENS[index % PENS.length]})`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}

/**
 * Shrink large photos in the browser before upload: faster on mobile data,
 * and it converts formats like HEIC (on Safari) into JPEG the API accepts.
 */
export async function prepareReceiptFile(file: File, maxEdge = 2000): Promise<Blob> {
  if (file.type === 'application/pdf') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    return blob ?? file;
  } catch {
    return file;
  }
}
