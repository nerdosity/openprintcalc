// Lettore zip minimale: central directory + entry store (0) / deflate (8).

export interface ZipReader {
  names: string[];
  has(name: string): boolean;
  readEntry(name: string): Promise<Uint8Array>;
}

interface Entry { method: number; csize: number; usize: number; offset: number; }

export function openZip(buffer: ArrayBuffer): ZipReader {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Non e un file zip valido (EOCD mancante).');
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map<string, Entry>();
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buffer.byteLength || view.getUint32(pos, true) !== 0x02014b50) throw new Error('Central directory zip corrotta.');
    const nameLen = view.getUint16(pos + 28, true), extraLen = view.getUint16(pos + 30, true), commLen = view.getUint16(pos + 32, true);
    const name = dec.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    entries.set(name, {
      method: view.getUint16(pos + 10, true), csize: view.getUint32(pos + 20, true),
      usize: view.getUint32(pos + 24, true), offset: view.getUint32(pos + 42, true),
    });
    pos += 46 + nameLen + extraLen + commLen;
  }
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    async readEntry(name: string): Promise<Uint8Array> {
      const e = entries.get(name);
      if (!e) throw new Error(`Entry zip non trovata: ${name}`);
      const o = e.offset;
      if (view.getUint32(o, true) !== 0x04034b50) throw new Error('Local header zip non valido.');
      const start = o + 30 + view.getUint16(o + 26, true) + view.getUint16(o + 28, true);
      const data = bytes.slice(start, start + e.csize);
      if (e.method === 0) return data;
      if (e.method !== 8) throw new Error(`Metodo di compressione zip non supportato: ${e.method}`);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    },
  };
}
