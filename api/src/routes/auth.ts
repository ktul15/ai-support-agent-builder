import { Router } from 'express';
import { z } from 'zod';
import { AuthError, login, signup } from '../auth/auth-service.js';

// Email is normalized (trim + lowercase) on BOTH signup and login so matching is
// case-insensitive and the global-uniqueness check is consistent.
const signupSchema = z.object({
  tenantName: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(200),
});

/**
 * Public auth routes — NOT behind tenantContext (there is no tenant yet). They
 * mint the JWT that every protected route later requires. Uses
 * .then(onFulfilled, onRejected) so a downstream/runtime error is never masked
 * as an auth failure.
 */
export function authRouter(): Router {
  const r = Router();

  r.post('/auth/signup', (req, res) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request' });
      return;
    }
    signup(parsed.data).then(
      (out) => res.status(201).json({ token: out.token }),
      (err) => sendError(res, err),
    );
  });

  r.post('/auth/login', (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request' });
      return;
    }
    login(parsed.data).then(
      (out) => res.json({ token: out.token }),
      (err) => sendError(res, err),
    );
  });

  return r;
}

function sendError(res: import('express').Response, err: unknown): void {
  if (err instanceof AuthError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('auth route error:', err);
  res.status(500).json({ error: 'internal error' });
}
