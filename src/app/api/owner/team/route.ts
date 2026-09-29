import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { hashPassword, generateTempPassword } from "@/lib/password";
import { logPlatformAction } from "@/lib/platform";
import { TEAM_INVITABLE_ROLES, PLATFORM_ROLE_LABELS } from "@/lib/owner-roles";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * GET /api/owner/team — PlatformUser roster (software_owner + invited members)
 * with status, role and login metadata. Software Owner only.
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;

  const members = await db.platformUser.findMany({
    orderBy: [{ createdAt: "asc" }],
  });

  return NextResponse.json({
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      active: m.active,
      mustChangePassword: m.mustChangePassword,
      isDemo: m.isDemo,
      lastLoginAt: m.lastLoginAt,
      createdAt: m.createdAt,
    })),
    total: members.length,
  });
}

/**
 * POST /api/owner/team — invite a platform team member.
 *
 * The account is created on a TEMPORARY password (`Vlx@XXXXXXXX`) with
 * mustChangePassword=true: on first login the member is forced to set a
 * permanent password (policy-validated, stored only as a scrypt hash).
 * The temp password is returned ONCE in this response for secure hand-off —
 * it is never written to the audit trail or any other surface.
 */
export async function POST(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;

  const body = await req.json().catch(() => null);
  const name = String((body as Record<string, unknown> | null)?.name ?? "").trim();
  const email = String((body as Record<string, unknown> | null)?.email ?? "").trim().toLowerCase();
  const role = String((body as Record<string, unknown> | null)?.role ?? "");

  if (name.length < 2) return NextResponse.json({ error: "Enter the member's full name" }, { status: 400 });
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  if (!(TEAM_INVITABLE_ROLES as readonly string[]).includes(role)) {
    return NextResponse.json(
      { error: "Invalid role — members can be Platform Admin, Platform Support or Platform Finance" },
      { status: 400 }
    );
  }

  const existing = await db.platformUser.findUnique({ where: { email } });
  if (existing) return NextResponse.json({ error: "A platform account with this email already exists" }, { status: 409 });

  // Avoid split-brain identities: the same email must not exist as hotel staff either.
  const staffClash = await db.staff.findUnique({ where: { email } });
  if (staffClash) {
    return NextResponse.json(
      { error: "This email is already used by a hotel staff account — use a different address" },
      { status: 409 }
    );
  }

  const temp = generateTempPassword();
  const member = await db.platformUser.create({
    data: {
      name,
      email,
      role,
      passwordHash: hashPassword(temp),
      mustChangePassword: true,
      active: true,
      isDemo: false,
    },
  });

  await logPlatformAction({
    actorId: owner.sub,
    actorName: owner.email,
    action: "TEAM_INVITE",
    entity: "platform_user",
    entityId: member.id,
    details: `Invited ${name} <${email}> as ${PLATFORM_ROLE_LABELS[role as keyof typeof PLATFORM_ROLE_LABELS]} — temporary password issued, permanent password must be set on first login`,
  });

  return NextResponse.json(
    {
      ok: true,
      member: {
        id: member.id, name: member.name, email: member.email, role: member.role,
        active: member.active, mustChangePassword: member.mustChangePassword,
        lastLoginAt: member.lastLoginAt, createdAt: member.createdAt,
      },
      tempPassword: temp,
    },
    { status: 201 }
  );
}
