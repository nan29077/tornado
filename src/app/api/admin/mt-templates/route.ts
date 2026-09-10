import { prisma } from '@/server/db';
import { requireAdmin, writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import { isRecord } from '@/lib/json-body';
import {
  MT_TEMPLATE_CODES,
  MT_TEMPLATE_META,
  SECURE_LINK_TEMPLATES,
  clearMtTemplateOverrideCache,
  validateMtTemplateBody,
  type MtTemplateCode,
} from '@/server/services/mt-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * MT 문자 본문 관리 API.
 *
 * 관리 화면은 서버 액션으로 저장하지만, 운영 도구/스크립트에서 문구를 일괄 확인하거나
 * 되돌려야 할 때가 있어 같은 규칙을 쓰는 HTTP 경로를 함께 둔다.
 *
 *  GET  /api/admin/mt-templates            전체 목록 (코드 기본값 + 저장된 커스텀 본문)
 *  POST /api/admin/mt-templates            { code, body }  저장
 *                                          { code, reset: true }  기본 문구로 되돌리기
 *
 * 화면 액션과 동일하게 최고관리자·운영 권한만 변경할 수 있다.
 * 문자 본문은 후원자에게 그대로 발송되므로 검증 규칙을 우회하는 경로를 만들지 않는다.
 */

const WRITE_PERMISSIONS = new Set(['SUPER_ADMIN', 'OPERATION']);

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export async function GET() {
  const admin = await requireAdmin().catch(() => null);
  if (!admin) return json({ ok: false, message: '관리자 로그인이 필요합니다.' }, 401);

  const rows = await prisma.mtMessageTemplate.findMany({
    select: { code: true, body: true, updatedBy: true, updatedAt: true },
  });
  const saved = new Map(rows.map((r) => [r.code, r]));

  return json({
    ok: true,
    templates: MT_TEMPLATE_CODES.map((code) => {
      const meta = MT_TEMPLATE_META[code];
      const row = saved.get(code);
      return {
        code,
        label: meta.label,
        description: meta.description,
        editable: meta.editable,
        variables: meta.variables,
        defaultBody: meta.defaultBody,
        customBody: row?.body ?? null,
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    }),
  });
}

export async function POST(req: Request) {
  const admin = await requireAdmin().catch(() => null);
  if (!admin) return json({ ok: false, message: '관리자 로그인이 필요합니다.' }, 401);
  if (!WRITE_PERMISSIONS.has(String(admin.adminPermission))) {
    return json({ ok: false, message: '문자 본문 수정은 최고관리자 또는 운영 권한에서만 할 수 있습니다.' }, 403);
  }

  let payload: { code?: unknown; body?: unknown; reset?: unknown };
  try {
    const raw: unknown = await req.json();
    // JSON 은 null · 숫자 · 배열도 유효한 본문이다. 그대로 payload.code 를 읽으면 500 이 난다.
    if (!isRecord(raw)) throw new Error('object required');
    payload = raw as typeof payload;
  } catch {
    return json({ ok: false, message: '요청 본문(JSON)을 읽을 수 없습니다.' }, 400);
  }

  const code = String(payload.code ?? '') as MtTemplateCode;
  if (!MT_TEMPLATE_META[code]) return json({ ok: false, message: '알 수 없는 문자 템플릿 코드입니다.' }, 400);

  /**
   * **코드별 등급 검사.** 화면 액션(`assertMtTemplateAdmin`)은 보안링크가 들어가는 문자
   * (최초 등록 안내 · 후원 확인 · PIN 입력)를 최고관리자 전용으로 막는다. 결제 흐름 자체를
   * 좌우하는 문구라 운영 권한에도 열지 않는다는 판단이었다.
   *
   * 그런데 같은 일을 하는 이 HTTP 경로는 위에서 평평한 등급 검사만 하고 끝나서,
   * 운영 권한 계정이 `POST {code: <보안링크 문자>, body: ...}` 로 **후원자 휴대폰에 찍히는
   * 결제 안내 문구를 그대로 고쳐 쓸 수 있었다.** 액션과 같은 규칙을 적용한다.
   * (`{보안링크}` 치환자는 validateMtTemplateBody 가 계속 강제하므로 링크 자체는 못 뺀다)
   */
  if (SECURE_LINK_TEMPLATES.has(code) && String(admin.adminPermission) !== 'SUPER_ADMIN') {
    return json(
      {
        ok: false,
        message: `"${MT_TEMPLATE_META[code].label}" 문자는 결제 흐름에 직접 관여하므로 최고관리자만 수정할 수 있습니다.`,
      },
      403,
    );
  }

  // 되돌리기: 커스텀 본문을 지우면 코드 기본 문구가 다시 쓰인다.
  if (payload.reset === true) {
    const before = await prisma.mtMessageTemplate.findUnique({ where: { code }, select: { body: true } });
    if (!before) return json({ ok: false, message: '저장된 커스텀 본문이 없습니다.' }, 404);

    await prisma.mtMessageTemplate.delete({ where: { code } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'MT_TEMPLATE_RESET',
      targetType: 'MtMessageTemplate',
      targetId: code,
      before: { body: before.body },
    });
    clearMtTemplateOverrideCache();
    return json({ ok: true, code, customBody: null });
  }

  const body = String(payload.body ?? '');
  const problem = validateMtTemplateBody(code, body);
  if (problem) return json({ ok: false, message: problem }, 400);

  const before = await prisma.mtMessageTemplate.findUnique({ where: { code }, select: { body: true } });
  const saved = await prisma.mtMessageTemplate.upsert({
    where: { code },
    create: { id: newId(), code, body, updatedBy: admin.id },
    update: { body, updatedBy: admin.id },
    select: { code: true, body: true, updatedAt: true },
  });

  await writeAudit({
    adminUserId: admin.id,
    action: before ? 'MT_TEMPLATE_UPDATE' : 'MT_TEMPLATE_CREATE',
    targetType: 'MtMessageTemplate',
    targetId: code,
    before: before ? { body: before.body } : undefined,
    after: { body },
  });

  // 발송 경로의 짧은 캐시를 비워 다음 발송부터 바로 적용되게 한다.
  clearMtTemplateOverrideCache();
  return json({ ok: true, code: saved.code, customBody: saved.body, updatedAt: saved.updatedAt });
}
