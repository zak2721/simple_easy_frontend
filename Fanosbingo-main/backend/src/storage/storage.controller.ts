import { Controller, ForbiddenException, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import * as path from 'path';
import { Public } from '../common/decorators/public.decorator';
import { StorageService } from './storage.service';

/**
 * Serves receipt files ONLY via a short-lived HMAC-signed path (see
 * StorageService.signPath) — never a public/guessable URL. The signature is
 * the access control here; there is no bearer-token check because the
 * signed link itself IS the capability, already minted by an authorized
 * deposits/withdrawals/admin route for the specific requester.
 */
@Controller('storage/receipts')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Get(':path')
  async get(@Param('path') relPath: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    if (!this.storage.verifySignedAccess(decodeURIComponent(relPath), exp, sig)) {
      throw new ForbiddenException('Signature invalid or expired');
    }
    const absolute = this.storage.resolveAbsolutePath(decodeURIComponent(relPath));
    res.sendFile(absolute);
  }
}

/**
 * Public, unsigned, cacheable — admin-curated brand assets (theme logos/
 * banners), never user-private documents. No auth check by design.
 */
@Controller('storage/public')
export class PublicStorageController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Get(':folder/:filename')
  async get(@Param('folder') folder: string, @Param('filename') filename: string, @Res() res: Response) {
    const absolute = this.storage.resolvePublicAbsolutePath(path.join(folder, filename));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(absolute);
  }
}
