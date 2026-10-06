import * as crypto from 'crypto';

const VERSION = 'v1';

function loadKey(rawKey: string | undefined): Buffer {
  if (!rawKey) throw new Error('PLATFORM_ENCRYPTION_KEY is not configured');
  const key = Buffer.from(rawKey, 'base64');
  if (key.length !== 32) throw new Error('PLATFORM_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  return key;
}

/** AES-256-GCM. Output: "v1:<iv>:<authTag>:<ciphertext>", each part base64. */
export function encryptSecret(plaintext: string, rawKey: string | undefined): string {
  const key = loadKey(rawKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptSecret(payload: string, rawKey: string | undefined): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(':');
  if (version !== VERSION || !ivB64 || !tagB64 || dataB64 === undefined) throw new Error('Unrecognized secret format');
  const key = loadKey(rawKey);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
