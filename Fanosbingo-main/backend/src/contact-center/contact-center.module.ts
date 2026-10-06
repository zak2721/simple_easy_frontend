import { Module } from '@nestjs/common';
import { ContactController, AdminContactCenterController } from './contact-center.controller';

@Module({
  controllers: [ContactController, AdminContactCenterController],
})
export class ContactCenterModule {}
