import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  /** Server-authoritative ranking by total winnings (spec §37), within one operator only. */
  async top(operatorId: string, limit = 20) {
    const rows = await this.prisma.$queryRaw<Array<{ telegram_user_id: bigint; username: string | null; first_name: string | null; total_won: number }>>`
      SELECT u.telegram_user_id, u.username, u.first_name, COALESCE(SUM(l.amount), 0)::float AS total_won
      FROM telegram_users u
      JOIN wallet_ledger l ON l.telegram_user_id = u.id AND l.entry_type = 'WINNING_CREDIT'
      WHERE u.operator_id = ${operatorId}
      GROUP BY u.id
      ORDER BY total_won DESC, u.telegram_user_id ASC
      LIMIT ${limit}
    `;
    return rows.map((r, i) => ({
      rank: i + 1,
      telegram_user_id: Number(r.telegram_user_id),
      username: r.username,
      first_name: r.first_name,
      total_won: r.total_won,
    }));
  }
}
