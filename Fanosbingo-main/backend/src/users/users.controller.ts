import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtPlayerGuard } from '../common/guards/jwt-player.guard';
import { CurrentUser, RequestPlayer } from '../common/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { SetLanguageDto } from '../auth/dto/auth.dto';
import { SetUserThemeDto } from '../theme/dto/theme.dto';

@Controller('users')
@UseGuards(JwtPlayerGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post('language')
  setLanguage(@CurrentUser() player: RequestPlayer, @Body() dto: SetLanguageDto) {
    return this.users.setLanguage(player.userId, dto.languageCode);
  }

  @Post('theme')
  setTheme(@CurrentUser() player: RequestPlayer, @Body() dto: SetUserThemeDto) {
    return this.users.setTheme(player.userId, dto.themeId ?? null);
  }

  @Get('me/finance')
  myFinance(@CurrentUser() player: RequestPlayer) {
    return this.users.myFinance(player.userId, player.operatorId);
  }
}
