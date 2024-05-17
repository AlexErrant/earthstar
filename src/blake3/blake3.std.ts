import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

export async function blake3(
  source: Uint8Array | AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const buffer = await crypto.subtle.digest("BLAKE3", source);

  return new Uint8Array(buffer);
}