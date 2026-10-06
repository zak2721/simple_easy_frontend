import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtPlayerStrategy } from './strategies/jwt-player.strategy';
import { JwtAdminStrategy } from './strategies/jwt-admin.strategy';
import { PasswordService } from './password.service';
import { LoginHistoryService } from './login-history.service';
import { ReferralsModule } from '../referrals/referrals.module';
import { BonusModule } from '../bonus/bonus.module';
import { ThemeModule } from '../theme/theme.module';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET'),
      }),
    }),
    ReferralsModule,
    BonusModule,
    ThemeModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtPlayerStrategy, JwtAdminStrategy, PasswordService, LoginHistoryService],
  exports: [AuthService, PasswordService, LoginHistoryService],
})
export class AuthModule {}
