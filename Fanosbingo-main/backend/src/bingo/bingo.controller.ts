import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { JwtPlayerGuard } from '../common/guards/jwt-player.guard';
import { CurrentUser, RequestPlayer } from '../common/decorators/current-user.decorator';
import { BingoService } from './bingo.service';

class ClaimBingoDto {
  @IsString()
  @IsNotEmpty()
  playerId!: string;
}

@Controller('bingo')
@UseGuards(JwtPlayerGuard)
export class BingoController {
  constructor(private readonly bingo: BingoService) {}

  @Post('claim')
  claim(@CurrentUser() player: RequestPlayer, @Body() dto: ClaimBingoDto) {
    return this.bingo.claimBingo(dto.playerId, player.userId);
  }
}
