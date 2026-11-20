import { Zip, ZipPassThrough } from 'fflate';

export function downloadZip(files: { name: string; open: () => Promise<ReadableStream<Uint8Array>> }[]) {
  const names = new Set<string>();
  let chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });

  async function* encode() {
    for (const [index, file] of files.entries()) {
      let name = file.name.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/, '') || 'file';
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
      while (names.has(name.toLowerCase())) name = `${index + 1}-${name}`;
      names.add(name.toLowerCase());

      const entry = new ZipPassThrough(name);
      zip.add(entry);
      for await (const chunk of await file.open()) {
        entry.push(chunk, false);
        yield* chunks;
        chunks = [];
      }
      entry.push(new Uint8Array(), true);
      yield* chunks;
      chunks = [];
    }
    zip.end();
    yield* chunks;
  }

  const source = encode();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await source.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    async cancel() {
      await source.return(undefined);
    },
  });
}
