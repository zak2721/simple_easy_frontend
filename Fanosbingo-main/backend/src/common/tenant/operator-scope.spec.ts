import { describe, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { readScope, writeTarget } from './operator-scope';
import { PlatformAdminGuard } from '../guards/platform-admin.guard';
import { DEFAULT_OPERATOR_ID } from '../operator.constants';
import type { RequestAdmin } from '../decorators/current-user.decorator';

const admin = (operatorId: string | null): RequestAdmin => ({
  adminId: 'a1',
  sessionId: 's1',
  username: 'u',
  fullName: 'U',
  permissions: [],
  roles: ['ADMIN'],
  operatorId,
  totpEnabled: false,
  impersonatedByAdminId: null,
  telegramAlertChatId: null,
});

describe('operator scope helpers', () => {
  describe('readScope', () => {
    it('platform admin with no filter sees every operator (null)', () => {
      expect(readScope(admin(null))).toBeNull();
    });

    it('platform admin can narrow to one operator', () => {
      expect(readScope(admin(null), 'op-b')).toBe('op-b');
    });

    it('operator-bound admin is always pinned to their own operator', () => {
      expect(readScope(admin('op-a'))).toBe('op-a');
      expect(readScope(admin('op-a'), 'op-a')).toBe('op-a');
    });

    it('operator-bound admin asking for another operator is refused, not silently re-scoped', () => {
      expect(() => readScope(admin('op-a'), 'op-b')).toThrow(ForbiddenException);
    });
  });

  describe('writeTarget', () => {
    it('platform admin with no filter writes to the default operator (existing admin panel unchanged)', () => {
      expect(writeTarget(admin(null))).toBe(DEFAULT_OPERATOR_ID);
    });

    it('platform admin can target a specific operator', () => {
      expect(writeTarget(admin(null), 'op-b')).toBe('op-b');
    });

    it('operator-bound admin always writes to their own operator', () => {
      expect(writeTarget(admin('op-a'))).toBe('op-a');
      expect(() => writeTarget(admin('op-a'), 'op-b')).toThrow(ForbiddenException);
    });
  });

  describe('PlatformAdminGuard', () => {
    const ctx = (a: RequestAdmin | undefined) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ admin: a }) }) }) as never;

    it('allows platform admins', () => {
      expect(new PlatformAdminGuard().canActivate(ctx(admin(null)))).toBe(true);
    });

    it('refuses operator-bound admins', () => {
      expect(() => new PlatformAdminGuard().canActivate(ctx(admin('op-a')))).toThrow(ForbiddenException);
    });

    it('refuses a request with no admin context', () => {
      expect(() => new PlatformAdminGuard().canActivate(ctx(undefined))).toThrow(ForbiddenException);
    });
  });
});
