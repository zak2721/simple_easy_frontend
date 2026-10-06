import { Module } from '@nestjs/common';
import { SupportService } from './support.service';
import { FaqService } from './faq.service';
import { SupportPlayerController, SupportAdminController, SupportPlatformController } from './support.controller';
import { FaqPlayerController, FaqAdminController } from './faq.controller';

@Module({
  controllers: [SupportPlayerController, SupportAdminController, SupportPlatformController, FaqPlayerController, FaqAdminController],
  providers: [SupportService, FaqService],
})
export class SupportModule {}
