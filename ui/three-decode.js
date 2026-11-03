// Standalone worker: decode embedded or transferred model bytes off the UI thread.
self.onmessage = async ({data}) => {
  try {
    const bytes = data.b64 !== undefined
      ? Uint8Array.from(atob(data.b64), c => c.charCodeAt(0)) : new Uint8Array(data.bytes);
    const stream = new Blob([bytes]).stream();
    const buffer = await new Response(data.gzip === false ? stream
      : stream.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    self.postMessage({id: data.id, buffer}, [buffer]);
  } catch (error) {
    self.postMessage({id: data.id, error: String(error.message || error)});
  }
};
