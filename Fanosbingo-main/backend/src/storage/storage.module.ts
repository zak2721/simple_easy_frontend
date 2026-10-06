import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { StorageController, PublicStorageController } from './storage.controller';

@Module({
  controllers: [StorageController, PublicStorageController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
