import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminManagementService } from './admin-management.service';
import { AdminManagementController } from './admin-management.controller';

@Module({
  imports: [AuthModule],
  controllers: [AdminManagementController],
  providers: [AdminManagementService],
})
export class AdminManagementModule {}
