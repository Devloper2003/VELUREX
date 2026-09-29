import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { hashPassword, generateTempPassword } from "@/lib/password";
import { logPlatformAction } from "@/lib/platform";
import { TEAM_INVITABLE_ROLES, PLATFORM_ROLE_LABELS } from "@/lib/owner-roles";

type Params = { params: Promise<{ id: string }> };

/** Software-owner accounts are immutable from Team & Roles (single-owner invariant + self-protection). */
function isOwnerAccount(role: string) {
  return role === "software_owner";
}

/**
 * PATCH /api/owner/team/[id] — actions:
 *   update          { name?, role? }   rename / change role (invitable roles only)
 *   activate | deactivate
 *   reset_password  → issues a fresh Vlx@XXXXXXXX temp password (shown once)
 *   force_logout    → stale-stamps lastLoginAt; open tabs die on next poll
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const member = await db.platformUser.findUnique({ where: { id } });
  if (!member) return NextResponse.json({ error: "Team member not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const action = String((body as Record<string, unknown>).action ?? "");

  // ── Guard: the software_owner account (Sujeet Sharma) cannot be touched here.
  if (isOwnerAccount(member.role)) {
    return NextResponse.json(
      { error: "The Software Owner account cannot be modified from Team & Roles" },
      { status: 400 }
    );
  }
  // ── Guard: a member cannot change their own role or status (reset/logout allowed).
  if (member.id === owner.sub && ["update", "activate", "deactivate"].includes(action)) {
    return NextResponse.json({ error: "You cannot change your own role or status" }, { status: 400 });
  }

  switch (action) {
    case "update": {
      const name = body.name !== undefined ? String(body.name).trim() : member.name;
      const role = body.role !== undefined ? String(body.role) : member.role;
      if (name.length < 2) return NextResponse.json({ error: "Enter the member's full name" }, { status: 400 });
      if (!(TEAM_INVITABLE_ROLES as readonly string[]).includes(role)) {
        return NextResponse.json({ error: "Invalid role" }, { status: 400 });
      }
      const roleChanged = role !== member.role;
      await db.platformUser.update({ where: { id }, data: { name, role } });
      await logPlatformAction({
        actorId: owner.sub, actorName: owner.email, action: roleChanged ? "TEAM_ROLE_CHANGE" : "TEAM_MEMBER_UPDATED",
        entity: "platform_user", entityId: id,
        details: roleChanged
          ? `${member.name} <${member.email}> role changed ${PLATFORM_ROLE_LABELS[member.role as keyof typeof PLATFORM_ROLE_LABELS]} → ${PLATFORM_ROLE_LABELS[role as keyof typeof PLATFORM_ROLE_LABELS]}`
          : `Renamed ${member.name} → ${name} <${member.email}>`,
      });
      return NextResponse.json({ ok: true });
    }

    case "activate":
    case "deactivate": {
      const active = action === "activate";
      await db.platformUser.update({ where: { id }, data: { active } });
      await logPlatformAction({
        actorId: owner.sub, actorName: owner.email,
        action: active ? "TEAM_MEMBER_ACTIVATED" : "TEAM_MEMBER_DEACTIVATED",
        entity: "platform_user", entityId: id,
        details: `${member.name} <${member.email}> ${active ? "activated" : "deactivated"}`,
      });
      return NextResponse.json({ ok: true, active });
    }

    case "reset_password": {
      // Same temporary-password flow as invitations: Vlx@XXXXXXXX, forced
      // permanent reset on next login, stored only as a scrypt hash.
      const temp = generateTempPassword();
      await db.platformUser.update({
        where: { id },
        data: { passwordHash: hashPassword(temp), mustChangePassword: true },
      });
      await logPlatformAction({
        actorId: owner.sub, actorName: owner.email, action: "TEAM_PASSWORD_RESET",
        entity: "platform_user", entityId: id,
        details: `Password reset for ${member.name} <${member.email}> — temporary password issued, permanent reset forced on next login`,
      });
      return NextResponse.json({ ok: true, tempPassword: temp });
    }

    case "force_logout": {
      // Staleness trick shared with tenant users: /api/auth/me rejects tokens
      // whose iat predates lastLoginAt, so open tabs sign out on next poll.
      await db.platformUser.update({
        where: { id },
        data: { lastLoginAt: new Date(Date.now() + 5000) },
      });
      await logPlatformAction({
        actorId: owner.sub, actorName: owner.email, action: "TEAM_FORCE_LOGOUT",
        entity: "platform_user", entityId: id,
        details: `Force logout for ${member.name} <${member.email}> — active tabs signed out on next poll`,
      });
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}

/**
 * DELETE /api/owner/team/[id] — permanent removal. Only allowed for members
 * who never signed in and are currently deactivated (nothing to lose); else
 * the client is told to deactivate instead. Audited.
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const member = await db.platformUser.findUnique({ where: { id } });
  if (!member) return NextResponse.json({ error: "Team member not found" }, { status: 404 });
  if (isOwnerAccount(member.role)) {
    return NextResponse.json({ error: "The Software Owner account cannot be removed" }, { status: 400 });
  }
  if (member.lastLoginAt || member.active) {
    return NextResponse.json(
      { error: "Only never-signed-in, deactivated members can be removed — deactivate the member instead" },
      { status: 400 }
    );
  }

  await db.platformUser.delete({ where: { id } });
  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "TEAM_MEMBER_REMOVED",
    entity: "platform_user", entityId: id,
    details: `Removed team member ${member.name} <${member.email}> (${member.role}) — account never activated`,
  });
  return NextResponse.json({ ok: true });
}
