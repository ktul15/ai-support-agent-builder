import { describe, expect, it } from 'vitest';
import {
  loginSchema,
  signupSchema,
  isProtectedPath,
  mapAuthError,
  safeInternalPath,
} from './auth.js';

describe('auth schemas', () => {
  it('login accepts a valid email/password and normalizes the email', () => {
    const r = loginSchema.safeParse({ email: '  Foo@Bar.com ', password: 'x' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe('foo@bar.com');
  });

  it('login rejects a bad email or empty password', () => {
    expect(loginSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@b.com', password: '' }).success).toBe(false);
  });

  it('signup requires a business name and an 8+ char password', () => {
    expect(
      signupSchema.safeParse({ tenantName: '', email: 'a@b.com', password: 'longenough' }).success,
    ).toBe(false);
    expect(
      signupSchema.safeParse({ tenantName: 'Acme', email: 'a@b.com', password: 'short' }).success,
    ).toBe(false);
    expect(
      signupSchema.safeParse({ tenantName: 'Acme', email: 'a@b.com', password: 'longenough' })
        .success,
    ).toBe(true);
  });
});

describe('isProtectedPath', () => {
  it('protects app routes', () => {
    expect(isProtectedPath('/dashboard')).toBe(true);
    expect(isProtectedPath('/')).toBe(true);
  });
  it('exempts public auth pages, api routes, and next internals', () => {
    expect(isProtectedPath('/login')).toBe(false);
    expect(isProtectedPath('/signup')).toBe(false);
    expect(isProtectedPath('/api/auth/login')).toBe(false);
    expect(isProtectedPath('/_next/static/x.js')).toBe(false);
    expect(isProtectedPath('/favicon.ico')).toBe(false);
  });
});

describe('safeInternalPath (open-redirect guard)', () => {
  it('allows a local absolute path', () => {
    expect(safeInternalPath('/documents')).toBe('/documents');
  });
  it('rejects protocol-relative, absolute-URL, and empty targets', () => {
    expect(safeInternalPath('//evil.com')).toBe('/dashboard');
    expect(safeInternalPath('https://evil.com')).toBe('/dashboard');
    expect(safeInternalPath('relative')).toBe('/dashboard');
    expect(safeInternalPath(null)).toBe('/dashboard');
    expect(safeInternalPath(undefined)).toBe('/dashboard');
  });
});

describe('mapAuthError', () => {
  it('maps known statuses to friendly messages, defaults otherwise', () => {
    expect(mapAuthError(401)).toMatch(/incorrect/i);
    expect(mapAuthError(409)).toMatch(/already exists/i);
    expect(mapAuthError(400)).toMatch(/check the form/i);
    expect(mapAuthError(500)).toMatch(/something went wrong/i);
  });
});
