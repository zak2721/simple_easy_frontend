import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../rbac.constants';

export const PERMISSIONS_KEY = 'permissions';
/** Declares the permission(s) an admin route requires. ALL listed permissions must be held. */
export const Permissions = (...permissions: PermissionKey[]) => SetMetadata(PERMISSIONS_KEY, permissions);
