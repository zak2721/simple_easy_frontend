import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtPlayerGuard } from '../common/guards/jwt-player.guard';
import { CurrentUser, RequestPlayer } from '../common/decorators/current-user.decorator';
import { WithdrawalsService } from './withdrawals.service';
import { RequestWithdrawalDto } from './dto/withdrawals.dto';

/** Audit finding SEC-7 (Medium): see DepositsController's identical rationale. */
const WITHDRAWAL_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller('withdrawals')
@UseGuards(JwtPlayerGuard)
export class WithdrawalsController {
  constructor(private readonly withdrawals: WithdrawalsService) {}

  @Throttle(WITHDRAWAL_THROTTLE)
  @Post()
  request(@CurrentUser() player: RequestPlayer, @Body() dto: RequestWithdrawalDto) {
    return this.withdrawals.request(player.userId, player.operatorId, dto);
  }

  @Get()
  list(@CurrentUser() player: RequestPlayer) {
    return this.withdrawals.listForUser(player.userId);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() player: RequestPlayer, @Param('id') id: string) {
    return this.withdrawals.cancel(id, player.userId);
  }
}
