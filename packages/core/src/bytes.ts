const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/**
 * Web Crypto and OPFS want an ArrayBuffer-backed view. TS 5.7+ distinguishes
 * `Uint8Array<ArrayBuffer>` from views over SharedArrayBuffer, so normalise here.
 */
export function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) return bytes as Uint8Array<ArrayBuffer>;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export const compressionSupported = typeof CompressionStream === "function";

async function pipe(bytes: Uint8Array, transform: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const stream = new Blob([toBufferSource(bytes)]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
}

export function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
}

export function randomId(byteLength = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
