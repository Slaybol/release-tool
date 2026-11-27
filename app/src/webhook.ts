import { createHmac, timingSafeEqual } from 'node:crypto';

// GitHub signs each delivery with the webhook secret: X-Hub-Signature-256: sha256=<hex HMAC of the raw body>.
export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
