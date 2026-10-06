import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { FinanceService } from './finance.service';
import { AlertsService } from './alerts.service';
import { DepositsModule } from '../deposits/deposits.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { CardsModule } from '../cards/cards.module';
import { GamesModule } from '../games/games.module';
import { OperatorManagementModule } from '../operator-management/operator-management.module';

@Module({
  imports: [DepositsModule, WithdrawalsModule, CardsModule, GamesModule, OperatorManagementModule],
  controllers: [AdminController],
  providers: [AdminService, FinanceService, AlertsService],
})
export class AdminModule {}
