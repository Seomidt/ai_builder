/**
 * Phase 37 — Auth Platform Routes
 *
 * All routes under /api/auth/*
 * Rate-limited, audit-logged, no user enumeration.
 */

import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: "Too many auth requests. Please try again later." },
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: "Too many attempts. Please try again later." },
});

function getIp(req: Request): string | null {
  return req.socket?.remoteAddress ?? null;
}

function getSessionToken(req: Request): string | null {
  return req.cookies?.auth_session ?? (req.headers["x-session-token"] as string) ?? null;
}

export function registerAuthPlatformRoutes(app: Express): void {
  app.use(cookieParser());

  // ── POST /api/auth/login ─────────────────────────────────────────────────
  app.post("/api/auth/login", strictLimiter, async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body ?? {};
      if (!email || !password) return res.status(400).json({ error: "email and password required." });

      const { loginWithPassword } = await import("../lib/auth-platform/login-service");
      const result = await loginWithPassword({
        email,
        password,
        ipAddress: getIp(req),
        userAgent: req.headers["user-agent"] ?? null,
        res,
      });

      if (!result.ok) return res.status(401).json({ error: result.error });
      if (result.mfaRequired) {
        return res.json({ mfaRequired: true, pendingMfaToken: result.pendingMfaToken });
      }
      return res.json({ ok: true, userId: result.userId });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });

  // ── POST /api/auth/logout ─────────────────────────────────────────────────
  app.post("/api/auth/logout", authLimiter, async (req: Request, res: Response) => {
    try {
      const token  = getSessionToken(req);
      const userId = (req as any).user?.id;
      if (!token || !userId) return res.status(401).json({ error: "Not authenticated." });

      const { logout } = await import("../lib/auth-platform/login-service");
      await logout({
        sessionToken: token,
        userId,
        tenantId:     (req as any).user?.tenantId ?? null,
        ipAddress:    getIp(req),
        res,
      });
      return res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });

  // ── POST /api/auth/refresh ────────────────────────────────────────────────
  app.post("/api/auth/refresh", authLimiter, async (req: Request, res: Response) => {
    try {
      const token = getSessionToken(req);
      if (!token) return res.status(401).json({ error: "No session." });

      const { refreshSession } = await import("../lib/auth-platform/login-service");
      const result = await refreshSession({ sessionToken: token, res });
      if (!result.ok) return res.status(401).json({ error: result.error });
      return res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });

  // ── POST /api/auth/password-reset/request ────────────────────────────────
  app.post("/api/auth/password-reset/request", strictLimiter, async (req: Request, res: Response) => {
    try {
      const { email } = req.body ?? {};
      if (!email) return res.status(400).json({ error: "email required." });

      const { requestPasswordReset } = await import("../lib/auth-platform/password-reset-service");
      const msg = await requestPasswordReset({
        email,
        ipAddress: getIp(req),
        tenantId:  (req as any).user?.tenantId ?? null,
      });
      return res.json({ message: msg });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });

  // ── POST /api/auth/password-reset/confirm ────────────────────────────────
  app.post("/api/auth/password-reset/confirm", strictLimiter, async (req: Request, res: Response) => {
    try {
      const { token, newPassword, confirmPassword } = req.body ?? {};
      if (!token || !newPassword || !confirmPassword)
        return res.status(400).json({ error: "token, newPassword and confirmPassword required." });

      const { resetPassword } = await import("../lib/auth-platform/password-reset-service");
      const result = await resetPassword({ token, newPassword, confirmPassword, ipAddress: getIp(req) });
      if (!result.ok) return res.status(400).json({ error: result.error });
      return res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });

  // ── POST /api/auth/email-verification/request ────────────────────────────
  app.post("/api/auth/email-verification/request", authLimiter, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: "Not authenticated." });

      const { issueEmailVerification } = await import("../lib/auth-platform/email-verification-service");
      await issueEmailVerification({
        userId,
        tenantId:  (req as any).user?.tenantId ?? null,
        ipAddress: getIp(req),
      });
      return res.json({ message: "Verification email sent." });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });

  // ── POST /api/auth/email-verification/confirm ────────────────────────────
  app.post("/api/auth/email-verification/confirm", strictLimiter, async (req: Request, res: Response) => {
    try {
      const { token } = req.body ?? {};
      if (!token) return res.status(400).json({ error: "token required." });

      const { verifyEmailToken } = await import("../lib/auth-platform/email-verification-service");
      const result = await verifyEmailToken({ token, ipAddress: getIp(req) });
      if (!result.ok) return res.status(400).json({ error: result.error });
      return res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });

  // ── POST /api/auth/invite/accept ─────────────────────────────────────────
  app.post("/api/auth/invite/accept", strictLimiter, async (req: Request, res: Response) => {
    try {
      const { token } = req.body ?? {};
      const userId    = (req as any).user?.id;
      if (!token) return res.status(400).json({ error: "token required." });
      if (!userId) return res.status(401).json({ error: "Authentication required to accept invite." });

      const { acceptInvite } = await import("../lib/auth-platform/invite-service");
      const result = await acceptInvite({ token, userId, ipAddress: getIp(req) });
      if (!result.ok) return res.status(400).json({ error: result.error });
      return res.json({ ok: true, tenantId: result.tenantId, role: result.role });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });

  // ── POST /api/auth/mfa/enroll/start ──────────────────────────────────────
  app.post("/api/auth/mfa/enroll/start", authLimiter, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: "Not authenticated." });

      const { beginTotpEnrollment } = await import("../lib/auth-platform/mfa-service");
      const payload = await beginTotpEnrollment({
        userId,
        tenantId: (req as any).user?.tenantId ?? null,
      });
      return res.json({ secret: payload.secret, qrDataUrl: payload.qrDataUrl, otpAuthUrl: payload.otpAuthUrl });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });

  // ── POST /api/auth/mfa/enroll/verify ─────────────────────────────────────
  app.post("/api/auth/mfa/enroll/verify", authLimiter, async (req: Request, res: Response) => {
    try {
      const userId   = (req as any).user?.id;
      const { totpCode } = req.body ?? {};
      if (!userId)   return res.status(401).json({ error: "Not authenticated." });
      if (!totpCode) return res.status(400).json({ error: "totpCode required." });

      const { verifyTotpEnrollment } = await import("../lib/auth-platform/mfa-service");
      const result = await verifyTotpEnrollment({
        userId,
        totpCode,
        tenantId: (req as any).user?.tenantId ?? null,
      });
      if (!result.ok) return res.status(400).json({ error: result.error });
      return res.json({ ok: true, recoveryCodes: result.recoveryCodes });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });

  // ── POST /api/auth/mfa/challenge ──────────────────────────────────────────
  app.post("/api/auth/mfa/challenge", strictLimiter, async (req: Request, res: Response) => {
    try {
      const { pendingMfaToken, totpCode } = req.body ?? {};
      if (!pendingMfaToken || !totpCode)
        return res.status(400).json({ error: "pendingMfaToken and totpCode required." });

      const { completeMfaLogin } = await import("../lib/auth-platform/login-service");
      const result = await completeMfaLogin({
        pendingMfaToken,
        totpCode,
        ipAddress: getIp(req),
        userAgent: req.headers["user-agent"] ?? null,
        res,
      });
      if (!result.ok) return res.status(401).json({ error: result.error });
      return res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });

  // ── POST /api/auth/mfa/recovery ───────────────────────────────────────────
  app.post("/api/auth/mfa/recovery", strictLimiter, async (req: Request, res: Response) => {
    try {
      const { pendingMfaToken, recoveryCode } = req.body ?? {};
      if (!pendingMfaToken || !recoveryCode)
        return res.status(400).json({ error: "pendingMfaToken and recoveryCode required." });

      let payload: { userId: string; tenantId: string | null; exp: number };
      try {
        payload = JSON.parse(Buffer.from(pendingMfaToken, "base64").toString());
      } catch {
        return res.status(401).json({ error: "Invalid session." });
      }
      if (Date.now() > payload.exp) return res.status(401).json({ error: "Session expired." });

      const { useRecoveryCode } = await import("../lib/auth-platform/mfa-service");
      const result = await useRecoveryCode({
        userId:    payload.userId,
        code:      recoveryCode,
        ipAddress: getIp(req),
        tenantId:  payload.tenantId,
      });
      if (!result.ok) return res.status(401).json({ error: result.error });

      const { createSession } = await import("../lib/auth-platform/session-service");
      await createSession({
        userId:    payload.userId,
        tenantId:  payload.tenantId,
        ipAddress: getIp(req),
        userAgent: req.headers["user-agent"] ?? null,
        res,
      });
      return res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });

  // ── GET /api/auth/sessions ────────────────────────────────────────────────
  app.get("/api/auth/sessions", authLimiter, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: "Not authenticated." });

      const { listUserSessions } = await import("../lib/auth-platform/session-service");
      const sessions = await listUserSessions(userId);
      return res.json({ sessions: sessions.map(s => ({
        id:          s.id,
        deviceLabel: s.deviceLabel,
        ipAddress:   s.ipAddress,
        userAgent:   s.userAgent,
        createdAt:   s.createdAt,
        lastSeenAt:  s.lastSeenAt,
        expiresAt:   s.expiresAt,
      })) });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });

  // ── POST /api/auth/sessions/:id/revoke ────────────────────────────────────
  app.post("/api/auth/sessions/:id/revoke", authLimiter, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: "Not authenticated." });

      const { revokeSession } = await import("../lib/auth-platform/session-service");
      await revokeSession({
        sessionId: req.params.id,
        revokedBy: userId,
        reason:    "user_revoked",
        ipAddress: getIp(req),
        tenantId:  (req as any).user?.tenantId ?? null,
      });
      return res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });

  // ── POST /api/auth/sessions/revoke-others ─────────────────────────────────
  app.post("/api/auth/sessions/revoke-others", authLimiter, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      const token  = getSessionToken(req);
      if (!userId || !token) return res.status(401).json({ error: "Not authenticated." });

      const { revokeAllOtherSessions } = await import("../lib/auth-platform/session-service");
      const count = await revokeAllOtherSessions({
        userId,
        currentToken: token,
        ipAddress:    getIp(req),
        tenantId:     (req as any).user?.tenantId ?? null,
      });
      return res.json({ ok: true, revokedCount: count });
    } catch (err) { res.status(500).json({ error: "Internal error." }); }
  });
}
