import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { ThemeModule } from '../theme/theme.module';
import { OperatorManagementService } from './operator-management.service';
import { StaffService } from './staff.service';
import { LimitsService } from './limits.service';
import { RoomsService } from './rooms.service';
import { BrandingService } from './branding.service';
import { ApprovalsService } from './approvals.service';
import { LoginHistoryController, OperatorSelfController, PlatformOperatorsController } from './operator-management.controller';
import { OperatorConfigController, PlatformConfigController, PublicBrandingController } from './operator-config.controller';

@Module({
  imports: [AuthModule, StorageModule, ThemeModule],
  controllers: [
    PlatformOperatorsController,
    OperatorSelfController,
    LoginHistoryController,
    OperatorConfigController,
    PlatformConfigController,
    PublicBrandingController,
  ],
  providers: [OperatorManagementService, StaffService, LimitsService, RoomsService, BrandingService, ApprovalsService],
  exports: [ApprovalsService, LimitsService],
})
export class OperatorManagementModule {}
