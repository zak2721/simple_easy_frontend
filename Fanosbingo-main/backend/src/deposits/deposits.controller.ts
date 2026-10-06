import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtPlayerGuard } from '../common/guards/jwt-player.guard';
import { CurrentUser, RequestPlayer } from '../common/decorators/current-user.decorator';
import { DepositsService } from './deposits.service';
import { SubmitDepositDto } from './dto/deposits.dto';

/** Audit finding SEC-7 (Medium): deposit creation was left on the generic 120/min global limit — a real-money mutation/spam-abuse surface deserves its own budget, same reasoning as AuthController's AUTH_THROTTLE. */
const DEPOSIT_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller('deposits')
@UseGuards(JwtPlayerGuard)
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @Throttle(DEPOSIT_THROTTLE)
  @Post()
  submit(@CurrentUser() player: RequestPlayer, @Body() dto: SubmitDepositDto) {
    return this.deposits.submit(player.userId, player.operatorId, dto);
  }

  @Get()
  list(@CurrentUser() player: RequestPlayer) {
    return this.deposits.listForUser(player.userId);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() player: RequestPlayer, @Param('id') id: string) {
    return this.deposits.cancel(id, player.userId);
  }
}
