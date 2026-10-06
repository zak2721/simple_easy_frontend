import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TenantContextInterceptor } from './common/tenant/tenant-context.interceptor';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { OperatorsModule } from './operators/operators.module';
import { OperatorManagementModule } from './operator-management/operator-management.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SupportModule } from './support/support.module';
import { AuditModule } from './audit/audit.module';
import { TelegramModule } from './telegram/telegram.module';
import { SettingsModule } from './settings/settings.module';
import { WalletModule } from './wallet/wallet.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { CardsModule } from './cards/cards.module';
import { GamesModule } from './games/games.module';
import { BingoModule } from './bingo/bingo.module';
import { StorageModule } from './storage/storage.module';
import { DepositsModule } from './deposits/deposits.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { AdminModule } from './admin/admin.module';
import { AdminManagementModule } from './admin-management/admin-management.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { GameRulesModule } from './game-rules/game-rules.module';
import { ReferralsModule } from './referrals/referrals.module';
import { BonusModule } from './bonus/bonus.module';
import { ContactCenterModule } from './contact-center/contact-center.module';
import { ThemeModule } from './theme/theme.module';
import { LoggerModule } from './common/logger/logger.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthController } from './health/health.controller';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { ContentPagesModule } from './content-pages/content-pages.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule,
    MetricsModule,
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        // Sensitive endpoints (auth, deposits, withdrawals, admin login) get a
        // tighter override via @Throttle() where applied; this is the general default.
        limit: 120,
      },
    ]),
    PrismaModule,
    OperatorsModule,
    NotificationsModule,
    SupportModule,
    AuditModule,
    TelegramModule,
    SettingsModule,
    WalletModule,
    AuthModule,
    UsersModule,
    CardsModule,
    BingoModule,
    GamesModule,
    StorageModule,
    DepositsModule,
    WithdrawalsModule,
    AdminModule,
    AdminManagementModule,
    OperatorManagementModule,
    LeaderboardModule,
    GameRulesModule,
    ReferralsModule,
    BonusModule,
    ContactCenterModule,
    ThemeModule,
    SubscriptionsModule,
    ContentPagesModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
export class AppModule {}
