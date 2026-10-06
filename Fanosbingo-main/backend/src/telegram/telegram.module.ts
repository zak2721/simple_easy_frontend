import { Global, Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { TelegramBotController } from './telegram-bot.controller';

@Global()
@Module({
  controllers: [TelegramBotController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
