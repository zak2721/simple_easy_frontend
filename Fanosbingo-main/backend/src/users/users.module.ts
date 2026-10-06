import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { DepositsModule } from '../deposits/deposits.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';

@Module({
  imports: [DepositsModule, WithdrawalsModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
