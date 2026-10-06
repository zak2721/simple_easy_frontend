import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtPlayerGuard } from '../common/guards/jwt-player.guard';
import { CurrentUser, RequestPlayer } from '../common/decorators/current-user.decorator';
import { WalletService } from './wallet.service';

@Controller('wallet')
@UseGuards(JwtPlayerGuard)
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  async getWallet(@CurrentUser() player: RequestPlayer) {
    return this.wallet.getWallet(player.userId);
  }

  @Get('transactions')
  async getTransactions(@CurrentUser() player: RequestPlayer) {
    const ledger = await this.wallet.getLedger(player.userId);
    return { ledger };
  }
}
