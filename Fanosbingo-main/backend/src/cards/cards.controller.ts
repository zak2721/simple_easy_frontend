import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtPlayerGuard } from '../common/guards/jwt-player.guard';
import { CurrentUser, RequestPlayer } from '../common/decorators/current-user.decorator';
import { CardsService } from './cards.service';
import { SelectCartelaDto, ReleaseCartelaDto } from './dto/cards.dto';

@Controller('cards')
@UseGuards(JwtPlayerGuard)
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Post('purchase')
  purchase(@CurrentUser() player: RequestPlayer, @Body() dto: SelectCartelaDto) {
    return this.cards.selectCartela({
      gameId: dto.gameId,
      room: dto.room,
      cartelaNumber: dto.cartelaNumber,
      userId: player.userId,
      operatorId: player.operatorId,
    });
  }

  @Post('release')
  release(@CurrentUser() player: RequestPlayer, @Body() dto: ReleaseCartelaDto) {
    return this.cards.releaseCartela(dto.playerId, player.userId);
  }
}
