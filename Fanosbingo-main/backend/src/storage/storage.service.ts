import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const ALLOWED_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
};
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Private on-disk receipt storage. Files never touch a public URL —
 * `getSignedPath` issues a short-lived, HMAC-signed path that only
 * DepositsService/WithdrawalsService/Admin routes can mint.
 *
 * Local disk in dev; can be swapped for an S3-compatible client in
 * production without touching callers (they only see `saveReceipt`/`signPath`).
 */
/**
 * Public, non-sensitive images only (theme logos/banners) — never receipts.
 * Audit finding SEC-3 (Medium): `image/svg+xml` used to be allowed here. SVG
 * can embed `<script>`, and these files are served unauthenticated with no
 * signature check (see PublicStorageController) — a weak/compromised admin
 * upload path would have been a direct stored-XSS vector on this app's own
 * origin. Removed; PNG/JPEG/WEBP cover every real theme-asset use case.
 */
const ALLOWED_PUBLIC_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
const MAX_PUBLIC_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Audit finding SEC-2 (Medium): the declared `data:<mime>;...` prefix was
 * trusted as-is — a client could label arbitrary bytes as `image/png`. This
 * verifies the actual file-signature (magic bytes) matches the claimed MIME
 * type before anything is written to disk, independent of what the client says.
 */
const MAGIC_BYTES: Record<string, (buf: Buffer) => boolean> = {
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  'application/pdf': (b) => b.length >= 5 && b.subarray(0, 5).toString('ascii') === '%PDF-',
};

@Injectable()
export class StorageService {
  private readonly root: string;
  private readonly publicRoot: string;
  private readonly signingSecret: string;

  constructor(private readonly config: ConfigService) {
    this.root = this.config.get<string>('RECEIPTS_STORAGE_PATH') ?? path.join(process.cwd(), 'storage', 'receipts');
    this.publicRoot = this.config.get<string>('PUBLIC_STORAGE_PATH') ?? path.join(process.cwd(), 'storage', 'public');
    const secret = this.config.get<string>('JWT_ACCESS_SECRET');
    if (!secret) throw new Error('JWT_ACCESS_SECRET is not configured');
    this.signingSecret = secret;
  }

  private parseDataUrl(base64DataUrl: string, allowedMime: Record<string, string>, maxBytes: number) {
    const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(base64DataUrl);
    if (!match) throw new BadRequestException('Invalid file payload');
    const [, mime, data] = match;

    const ext = allowedMime[mime];
    if (!ext) throw new BadRequestException(`Unsupported file type — allowed: ${Object.keys(allowedMime).join(', ')}`);

    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > maxBytes) throw new BadRequestException(`File too large (max ${Math.round(maxBytes / 1024 / 1024)}MB)`);
    if (buffer.length === 0) throw new BadRequestException('Empty file');

    const magicCheck = MAGIC_BYTES[mime];
    if (magicCheck && !magicCheck(buffer)) {
      throw new BadRequestException('File content does not match its declared type');
    }

    return { mime, ext, buffer };
  }

  async saveReceipt(base64DataUrl: string, folder: string): Promise<{ path: string; mime: string }> {
    const { mime, ext, buffer } = this.parseDataUrl(base64DataUrl, ALLOWED_MIME, MAX_BYTES);

    const dir = path.join(this.root, folder);
    await fs.mkdir(dir, { recursive: true });

    const filename = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, buffer);

    return { path: path.join(folder, filename), mime };
  }

  /**
   * Public, unsigned, persistent asset storage — categorically different
   * from saveReceipt's private/signed/short-lived model. Theme logos and
   * banners must load in <img> tags across every user's session
   * indefinitely, which a rotating signed URL can't do without constant
   * re-fetching. Served back via GET /storage/public/:folder/:filename
   * (StorageController) with no signature check — safe, since these are
   * admin-curated brand assets, not user-private documents.
   */
  async savePublicAsset(base64DataUrl: string, folder: string): Promise<{ path: string; mime: string }> {
    const { mime, ext, buffer } = this.parseDataUrl(base64DataUrl, ALLOWED_PUBLIC_MIME, MAX_PUBLIC_BYTES);

    const dir = path.join(this.publicRoot, folder);
    await fs.mkdir(dir, { recursive: true });

    const filename = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, buffer);

    return { path: path.join(folder, filename), mime };
  }

  /**
   * Audit finding SEC-4 (Low-Medium): `resolved.startsWith(root)` without a
   * trailing separator is the classic partial-prefix bug — a sibling
   * directory whose name merely starts with the same string (e.g. root
   * `storage/public` vs. a hypothetical `storage/public-backup`) would also
   * pass. Not currently exploitable (no such sibling exists under `storage/`
   * today), but this is the ONLY guard on the unauthenticated
   * PublicStorageController route, so it's hardened here rather than left
   * relying on there never being a matching directory name in the future.
   */
  private isWithinRoot(resolved: string, root: string): boolean {
    const normalizedRoot = path.resolve(root);
    return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep);
  }

  resolvePublicAbsolutePath(relativePath: string): string {
    const resolved = path.resolve(this.publicRoot, relativePath);
    if (!this.isWithinRoot(resolved, this.publicRoot)) {
      throw new BadRequestException('Invalid path'); // path traversal guard
    }
    return resolved;
  }

  /** Short-lived signed path — caller (an authorized deposits/withdrawals/admin route) already checked ownership/permission. */
  signPath(relativePath: string, ttlSeconds = 300): string {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = crypto.createHmac('sha256', this.signingSecret).update(`${relativePath}.${expires}`).digest('hex').slice(0, 32);
    return `/api/storage/receipts/${encodeURIComponent(relativePath)}?exp=${expires}&sig=${sig}`;
  }

  verifySignedAccess(relativePath: string, exp: string, sig: string): boolean {
    if (Number(exp) < Date.now() / 1000) return false;
    const expected = crypto.createHmac('sha256', this.signingSecret).update(`${relativePath}.${exp}`).digest('hex').slice(0, 32);
    const expectedBuf = Buffer.from(expected);
    const sigBuf = Buffer.from(sig);
    if (expectedBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, sigBuf);
  }

  resolveAbsolutePath(relativePath: string): string {
    const resolved = path.resolve(this.root, relativePath);
    if (!this.isWithinRoot(resolved, this.root)) {
      throw new BadRequestException('Invalid path'); // path traversal guard
    }
    return resolved;
  }
}
