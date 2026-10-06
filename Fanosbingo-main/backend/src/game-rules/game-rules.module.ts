import { Module } from '@nestjs/common';
import { GameRulesService } from './game-rules.service';
import { GameRulesController, AdminGameRulesController } from './game-rules.controller';

@Module({
  controllers: [GameRulesController, AdminGameRulesController],
  providers: [GameRulesService],
})
export class GameRulesModule {}
