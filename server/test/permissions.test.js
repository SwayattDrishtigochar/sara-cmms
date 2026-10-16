import { describe, expect, it } from 'vitest';
import { can, canGrant, canManageUser, permissionMap } from '../src/modules/permissions.js';

const mod = { label: 'Work Orders', permissionKey: 'work-order' };
const noKey = { label: 'Teams', permissionKey: null };

describe('permission matrix', () => {
  it.each([
    ['owner', 'delete', true],
    ['admin', 'update', true],
    ['superAdmin', 'create', true],
    ['view', 'read', true],
    ['view', 'create', false],
    ['view', 'update', false],
  ])('%s can %s → %s', (role, action, expected) => {
    expect(can({ role }, mod, action)).toBe(expected);
  });

  it('technicians follow their permission map', () => {
    const permissions = permissionMap(false);
    permissions['work-order'].add = true;
    const tech = { role: 'technician', permissions };
    expect(can(tech, mod, 'read')).toBe(true);
    expect(can(tech, mod, 'create')).toBe(true);
    expect(can(tech, mod, 'update')).toBe(false);
    expect(can(tech, noKey, 'create')).toBe(false);
  });

  it('only superadmins grant superadmin; admins only grant technician/view', () => {
    expect(canGrant({ role: 'owner' }, 'superAdmin')).toBe(false);
    expect(canGrant({ role: 'owner' }, 'admin')).toBe(true);
    expect(canGrant({ role: 'admin' }, 'admin')).toBe(false);
    expect(canGrant({ role: 'admin' }, 'technician')).toBe(true);
    expect(canGrant({ role: 'superAdmin' }, 'superAdmin')).toBe(true);
  });

  it('admins cannot manage owners', () => {
    expect(canManageUser({ role: 'admin', userId: 'a' }, { _id: 'o', role: 'owner' })).toBe(false);
    expect(canManageUser({ role: 'admin', userId: 'a' }, { _id: 't', role: 'technician' })).toBe(true);
    expect(canManageUser({ role: 'admin', userId: 'a' }, { _id: 'a', role: 'admin' })).toBe(true);
  });
});
