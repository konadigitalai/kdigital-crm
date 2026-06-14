import { Router } from "express";

export const meRouter = Router();

// /me — returns the authenticated user and their permission set.
meRouter.get("/", async (req, res) => {
  if (!req.user) {
    res.json({ me: null });
    return;
  }
  const u = req.user;
  const initials = (u.name ?? u.email)
    .trim()
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  res.json({
    me: {
      id: u.id,
      name: u.name ?? u.email,
      email: u.email,
      role: u.role,
      initials,
      permissions: Array.from(req.permissions ?? []),
    },
  });
});
