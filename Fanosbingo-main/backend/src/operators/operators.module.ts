import { Global, Module } from '@nestjs/common';
import { OperatorsService } from './operators.service';

@Global()
@Module({
  providers: [OperatorsService],
  exports: [OperatorsService],
})
export class OperatorsModule {}
