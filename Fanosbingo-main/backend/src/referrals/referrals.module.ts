import { Module } from '@nestjs/common';
import { ReferralsService } from './referrals.service';
import { ReferralsController, AdminReferralsController } from './referrals.controller';
import { BonusModule } from '../bonus/bonus.module';

@Module({
  imports: [BonusModule],
  controllers: [ReferralsController, AdminReferralsController],
  providers: [ReferralsService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
