import { Module } from '@nestjs/common';
import { GamesService } from './games.service';
import { GamesController } from './games.controller';
import { OperatorGamesController, PlatformGamesController } from './games-admin.controller';
import { BingoModule } from '../bingo/bingo.module';
import { OperatorManagementModule } from '../operator-management/operator-management.module';

@Module({
  imports: [BingoModule, OperatorManagementModule],
  controllers: [GamesController, OperatorGamesController, PlatformGamesController],
  providers: [GamesService],
  exports: [GamesService],
})
export class GamesModule {}
