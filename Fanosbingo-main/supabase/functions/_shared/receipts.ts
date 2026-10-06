// Receipt file validation + storage for የኛ (deposits & withdrawal proofs).
import { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

type Kind = { mime: string; ext: string };

/** Sniff the real file type from magic bytes — never trust the client filename/mime. */
function sniff(bytes: Uint8Array): Kind | null {
  if (bytes.length < 4) return null;
  // PNG  89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return { mime: 'image/png', ext: 'png' };
  // JPEG FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { mime: 'image/jpeg', ext: 'jpg' };
  // PDF  25 50 44 46  ("%PDF")
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)
    return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

export interface ReceiptResult {
  ok: boolean;
  error?: string;
  bytes?: Uint8Array;
  kind?: Kind;
}

/** Accepts a data URL or bare base64 string. Enforces type + size. */
export function validateReceipt(input: string | null | undefined): ReceiptResult {
  if (!input) return { ok: false, error: 'A receipt file is required' };
  const base64 = input.includes(',') ? input.slice(input.indexOf(',') + 1) : input;
  let bytes: Uint8Array;
  try {
    const bin = atob(base64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return { ok: false, error: 'Receipt is not valid base64' };
  }
  if (bytes.length === 0) return { ok: false, error: 'Receipt is empty' };
  if (bytes.length > MAX_BYTES) return { ok: false, error: 'Receipt is larger than 10 MB' };

  const kind = sniff(bytes);
  if (!kind) return { ok: false, error: 'Receipt must be a PNG, JPG/JPEG or PDF file' };

  return { ok: true, bytes, kind };
}

/**
 * Uploads a validated receipt into the private `receipts` bucket under
 * `<folder>/<random>.<ext>` and returns the object path. The bucket has no
 * public policies — files are only ever served through get-receipt with a
 * short-lived signed URL after an authorization check.
 */
export async function storeReceipt(
  supabase: SupabaseClient,
  folder: string,
  r: ReceiptResult,
): Promise<{ path: string; type: string }> {
  const name = `${crypto.randomUUID()}.${r.kind!.ext}`;
  const path = `${folder}/${name}`;
  const { error } = await supabase.storage
    .from('receipts')
    .upload(path, r.bytes!, { contentType: r.kind!.mime, upsert: false });
  if (error) throw new Error(`Failed to store receipt: ${error.message}`);
  return { path, type: r.kind!.mime };
}
