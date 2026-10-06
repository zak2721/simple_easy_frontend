import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtPlayerGuard } from '../common/guards/jwt-player.guard';
import { CurrentUser, RequestPlayer } from '../common/decorators/current-user.decorator';
import { LeaderboardService } from './leaderboard.service';

@Controller('leaderboard')
@UseGuards(JwtPlayerGuard)
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  top(@CurrentUser() player: RequestPlayer) {
    return this.leaderboard.top(player.operatorId);
  }
}
