import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  subject!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  message!: string;
}

export class ReplyTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;
}

export class SetTicketStatusDto {
  @IsIn(['open', 'pending', 'resolved', 'closed'])
  status!: 'open' | 'pending' | 'resolved' | 'closed';
}

export class AssignTicketDto {
  @IsOptional()
  @IsString()
  assignedAdminId?: string | null;
}

export class CreateFaqDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  question!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  answer!: string;
}

export class UpdateFaqDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  question?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  answer?: string;

  @IsOptional()
  isActive?: boolean;
}

export class ReorderFaqDto {
  @IsIn(['up', 'down'])
  direction!: 'up' | 'down';
}
