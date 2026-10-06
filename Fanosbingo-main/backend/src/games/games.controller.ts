import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtPlayerGuard } from '../common/guards/jwt-player.guard';
import { CurrentUser, RequestPlayer } from '../common/decorators/current-user.decorator';
import { GamesService } from './games.service';

@Controller('games')
@UseGuards(JwtPlayerGuard)
export class GamesController {
  constructor(private readonly games: GamesService) {}

  @Get('lobby')
  lobby(@CurrentUser() player: RequestPlayer) {
    return this.games.lobby(player.userId, player.operatorId);
  }

  @Get('active')
  async active(@CurrentUser() player: RequestPlayer) {
    const game = await this.games.getActiveGame(player.operatorId);
    return { game };
  }

  @Get(':id')
  getOne(@CurrentUser() player: RequestPlayer, @Param('id') id: string) {
    return this.games.getGameForPlayer(id, player.userId, player.operatorId);
  }
}
