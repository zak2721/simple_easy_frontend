import { Module } from '@nestjs/common';
import { BonusService } from './bonus.service';
import { AdminBonusSettingsController } from './bonus.controller';

@Module({
  controllers: [AdminBonusSettingsController],
  providers: [BonusService],
  exports: [BonusService],
})
export class BonusModule {}
