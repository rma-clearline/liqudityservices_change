// base64url helpers shared by the session signer and the Entra id_token verifier.
// Uses only globals available in both the Node runtime (route handlers, server
// components) and the Proxy: btoa/atob, TextEncoder/TextDecoder.

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Returns an ArrayBuffer-backed view (not ArrayBufferLike) so it satisfies the
// BufferSource parameter of crypto.subtle.* under TS's newer typed-array generics.
export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 === 0 ? "" : "=".repeat(4 - (norm.length % 4));
  const bin = atob(norm + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}
