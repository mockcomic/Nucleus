'use strict';
/* Download a fetch Response body into a Buffer with a hard byte cap enforced
   DURING the transfer. A check-after-the-fact (the content-length header, or
   buf.length after arrayBuffer()) leaves a window where a lying or malicious
   host can stream hundreds of MB into main before the cap bites — bounded
   only by the request timeout. Consuming res.body chunk-by-chunk returns the
   moment the running total crosses maxBytes, and returning out of for-await
   cancels the underlying stream.

   No Electron deps and no network here: plain-node testable with a fake
   response (test-bootstrap isolation rule — unit tests never hit the net). */
async function readCapped(res, maxBytes) {
  if (!res || !res.body) return { failed: true };
  const chunks = [];
  let total = 0;
  try {
    for await (const part of res.body) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      total += chunk.length;
      if (total > maxBytes) return { overflow: true };
      chunks.push(chunk);
    }
  } catch {
    return { failed: true };   // mid-transfer stream error — caller reports its own wording
  }
  return { buf: Buffer.concat(chunks, total) };
}

module.exports = { readCapped };
