import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { runWithTenant } from './tenant-context';

/**
 * Global interceptor: derives the request's operatorId from the already-
 * authenticated admin or player (guards run before interceptors in Nest's
 * pipeline, so req.admin/req.player are populated by now) and makes it
 * available for the rest of the request via AsyncLocalStorage. A request
 * with neither (a @Public() route) gets null, which common/tenant/rls.ts
 * treats as platform-level/unrestricted — correct, since every money- or
 * tenant-data-mutating $transaction in this codebase sits behind an admin
 * or player auth guard.
 *
 * The subscribe() call is made INSIDE runWithTenant's synchronous callback
 * deliberately: next.handle() returns a lazy Observable that Nest itself
 * subscribes to later, so wrapping the interceptor's return value in
 * runWithTenant(...) directly (without an explicit subscribe here) would
 * exit the AsyncLocalStorage context before the controller actually runs.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const operatorId: string | null = req?.admin?.operatorId ?? req?.player?.operatorId ?? null;
    const impersonatedByAdminId: string | null = req?.admin?.impersonatedByAdminId ?? null;

    return new Observable((subscriber) => {
      return runWithTenant(operatorId, impersonatedByAdminId, () => {
        const subscription = next.handle().subscribe(subscriber);
        return () => subscription.unsubscribe();
      });
    });
  }
}
