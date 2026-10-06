import { Module } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { OperatorsModule } from '../operators/operators.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OperatorManagementModule } from '../operator-management/operator-management.module';

@Module({
  imports: [PrismaModule, AuditModule, OperatorsModule, NotificationsModule, OperatorManagementModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
