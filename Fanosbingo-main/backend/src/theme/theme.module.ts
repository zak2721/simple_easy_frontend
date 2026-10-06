import { Module } from '@nestjs/common';
import { ThemeService } from './theme.service';
import { ThemeController, AdminThemeController } from './theme.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [ThemeController, AdminThemeController],
  providers: [ThemeService],
  exports: [ThemeService],
})
export class ThemeModule {}
