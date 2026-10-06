import { Controller, Get, Global, Module, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAdminGuard } from '../common/guards/jwt-admin.guard';
import { CurrentAdmin, RequestAdmin } from '../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

/** Any signed-in admin reads their own feed; the service decides which feed that is. */
@Controller('admin/notifications')
@UseGuards(JwtAdminGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentAdmin() admin: RequestAdmin,
    @Query('unread') unread?: string,
    @Query('operatorId') operatorId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.notifications.list(admin, { unreadOnly: unread === 'true', operatorId, limit: limit ? Number(limit) : undefined });
  }

  @Post('read-all')
  markAllRead(@CurrentAdmin() admin: RequestAdmin) {
    return this.notifications.markAllRead(admin);
  }

  @Post(':id/read')
  markRead(@CurrentAdmin() admin: RequestAdmin, @Param('id') id: string) {
    return this.notifications.markRead(admin, id);
  }
}

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
