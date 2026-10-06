import { Module } from '@nestjs/common';
import { ContentPagesService } from './content-pages.service';
import { ContentPagesAdminController, ContentPagesPlatformController, ContentPagesPlayerController } from './content-pages.controller';
import { OperatorManagementModule } from '../operator-management/operator-management.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule, OperatorManagementModule],
  controllers: [ContentPagesPlayerController, ContentPagesAdminController, ContentPagesPlatformController],
  providers: [ContentPagesService],
  exports: [ContentPagesService],
})
export class ContentPagesModule {}
