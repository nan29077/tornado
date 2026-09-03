import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, Notice, SectionTitle } from '@/components/ui';
import { MtTemplateEditor } from '@/components/admin/mt-template-editor';
import { ActionButton, ActionForm } from '@/components/admin/action-form';
import { saveMtTemplateAction, resetMtTemplateAction } from '@/app/actions/admin/mt-templates';
import { prisma } from '@/server/db';
import { getSessionUser } from '@/server/auth';
import { formatKst } from '@/lib/datetime';
import {
  MT_TEMPLATE_BODY_MAX_LENGTH,
  MT_TEMPLATE_CODES,
  MT_TEMPLATE_META,
  SECURE_LINK_TEMPLATES,
  type MtTemplateCode,
} from '@/server/services/mt-templates';

export const dynamic = 'force-dynamic';

/**
 * MT 문자 본문 관리.
 *
 * 여기서 저장한 본문이 코드 기본 문구를 대신해 실제 발송에 쓰인다(applyMtTemplateOverride).
 * 저장된 행이 없는 템플릿은 코드 기본 문구를 그대로 쓰므로, 이 화면을 한 번도 안 써도 동작은 같다.
 *
 * 권한이 두 단계로 갈린다.
 *  - 보안링크가 들어가는 문자(최초 등록 안내 · 후원 확인 · PIN 입력) → **최고관리자만**.
 *    안내 문장은 고칠 수 있지만 `{보안링크}` 치환자는 뺄 수 없다.
 *  - 그 밖의 안내 문자 → 최고관리자 또는 운영 권한.
 *
 * 후원 완료 감사 문자는 여기 저장한 문구가 **크리에이터가 스튜디오에서 직접 설정하지 않은**
 * 경우에만 나간다. 크리에이터가 설정했으면 그 문구가 우선한다.
 *
 * 발송 이력(어떤 문자가 실제로 나갔는지)은 /admin/mt-messages 에서 본다.
 */
export default async function AdminMtTemplatesPage() {
  const [rows, sessionUser] = await Promise.all([
    prisma.mtMessageTemplate.findMany({
      select: { code: true, body: true, updatedBy: true, updatedAt: true },
    }),
    getSessionUser(),
  ]);
  const saved = new Map(rows.map((r) => [r.code, r]));
  const isSuperAdmin = sessionUser?.adminPermission === 'SUPER_ADMIN';

  // 수정한 관리자 이름을 함께 보여준다 (누가 문구를 바꿨는지가 사고 추적의 시작점이다).
  const editorIds = [...new Set(rows.map((r) => r.updatedBy).filter((v): v is string => !!v))];
  const editors = editorIds.length
    ? await prisma.user.findMany({ where: { id: { in: editorIds } }, select: { id: true, name: true, email: true } })
    : [];
  const editorName = new Map(editors.map((u) => [u.id, u.name ?? u.email ?? u.id]));

  const secureCodes = MT_TEMPLATE_CODES.filter((c) => SECURE_LINK_TEMPLATES.has(c));
  const generalCodes = MT_TEMPLATE_CODES.filter((c) => MT_TEMPLATE_META[c].editable && !SECURE_LINK_TEMPLATES.has(c));
  const lockedCodes = MT_TEMPLATE_CODES.filter((c) => !MT_TEMPLATE_META[c].editable);
  const editableCount = secureCodes.length + generalCodes.length;
  const customCount = [...secureCodes, ...generalCodes].filter((c) => saved.has(c)).length;

  /** 템플릿 카드 하나. 보안링크 문자는 최고관리자가 아니면 저장 버튼이 잠긴다. */
  function templateCard(code: MtTemplateCode) {
    const meta = MT_TEMPLATE_META[code];
    const row = saved.get(code);
    const secure = SECURE_LINK_TEMPLATES.has(code);
    const locked = secure && !isSuperAdmin;

    return (
      <Card key={code}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{meta.label}</CardTitle>
          <div className="flex items-center gap-1.5">
            {secure ? <Badge tone="warning">최고관리자 전용</Badge> : null}
            <Badge tone={row ? 'brand' : 'neutral'}>{row ? '커스텀 문구' : '기본 문구'}</Badge>
            <span className="font-mono text-[11px] text-ink-400">{code}</span>
          </div>
        </div>

        <p className="mt-1 text-[12px] leading-relaxed text-ink-400">{meta.description}</p>

        <div className="mt-3 rounded-xl border border-ink-100 bg-ink-50 p-3">
          <p className="text-[11px] font-semibold text-ink-500">사용 가능한 치환자</p>
          {meta.variables.length === 0 ? (
            <p className="mt-1 text-[12px] text-ink-400">이 문자에는 치환자가 없습니다.</p>
          ) : (
            <ul className="mt-1.5 space-y-0.5">
              {meta.variables.map((v) => (
                <li key={v.token} className="text-[12px] text-ink-700">
                  <span className="font-mono font-semibold">{v.token}</span>
                  <span className="text-ink-400"> · {v.label}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-ink-400">기본 문구: {meta.defaultBody}</p>
        </div>

        {locked ? (
          <div className="mt-3">
            <Notice tone="neutral">
              이 문자는 결제 흐름에 직접 관여하므로 <strong className="text-ink-200">최고관리자만</strong> 수정할 수
              있습니다. 현재 문구는 위에서 확인하실 수 있습니다.
            </Notice>
          </div>
        ) : (
          <div className="mt-3">
            <ActionForm
              action={saveMtTemplateAction}
              submitLabel="본문 저장"
              confirm={
                secure
                  ? `"${meta.label}" 문구를 저장하면 다음 발송부터 후원자 휴대폰에 이 내용이 그대로 찍힙니다. 이 문자는 등록·결제 흐름에 직접 쓰입니다. 진행할까요?`
                  : `"${meta.label}" 문구를 저장하면 다음 발송부터 후원자 휴대폰에 이 내용이 그대로 찍힙니다. 진행할까요?`
              }
            >
              <MtTemplateEditor
                code={code}
                defaultBody={row?.body ?? meta.defaultBody}
                variables={meta.variables.map((v) => ({ ...v }))}
                maxLength={MT_TEMPLATE_BODY_MAX_LENGTH}
              />
            </ActionForm>
          </div>
        )}

        {row ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-3">
            <span className="text-[11px] text-ink-400">
              최종 수정 {formatKst(row.updatedAt, false)}
              {row.updatedBy ? ` · ${editorName.get(row.updatedBy) ?? row.updatedBy}` : ''}
            </span>
            {locked ? null : (
              <ActionButton
                action={resetMtTemplateAction}
                values={{ code }}
                label="기본 문구로 초기화"
                variant="danger"
                confirm={`"${meta.label}" 문자를 코드 기본 문구로 되돌립니다. 저장한 내용은 사라집니다. 진행할까요?`}
              />
            )}
          </div>
        ) : null}
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title="MT 메시지 관리"
        description="후원자에게 나가는 안내 문자 본문을 여기서 고칩니다. 저장하면 재배포 없이 다음 발송부터 적용됩니다. 실제 발송 이력은 'MT 발송' 화면에서 확인하세요."
      />

      <div className="mb-4">
        <Notice tone="warning" title="저장한 문구가 그대로 후원자 휴대폰에 찍힙니다">
          발신 주체 표기(<span className="font-semibold">[도네이도]</span>)는 본문 앞에 자동으로 붙습니다. &ldquo;결제되지
          않았습니다&rdquo; 같은 고지 문구를 지우면 후원자가 결제 여부를 오인할 수 있으니 문구를 바꿀 때 함께
          확인해 주세요. 현재 {editableCount}개 중 {customCount}개가 커스텀 문구를 쓰고 있습니다.
        </Notice>
      </div>

      <SectionTitle
        title="등록·결제 흐름 문자 (최고관리자 전용)"
        description="본문에 1회용 보안링크가 들어갑니다. 안내 문장은 고칠 수 있지만 {보안링크} 치환자를 빼면 저장되지 않습니다. 링크가 빠지면 후원자가 등록·결제를 끝낼 방법이 없어집니다."
      />
      {isSuperAdmin ? null : (
        <div className="mt-3">
          <Notice tone="neutral">
            현재 권한으로는 이 문자들을 조회만 할 수 있습니다. 수정은 최고관리자 계정으로 진행해 주세요.
          </Notice>
        </div>
      )}
      <div className="mt-3 grid gap-4 xl:grid-cols-2">{secureCodes.map(templateCard)}</div>

      <section className="mt-8">
        <SectionTitle
          title="안내 문자"
          description={`치환자는 대괄호가 아니라 중괄호({ }) 로 씁니다. 본문은 ${MT_TEMPLATE_BODY_MAX_LENGTH}자까지 입력할 수 있습니다.`}
        />
        <div className="mt-3">
          <Notice tone="neutral">
            <strong className="text-ink-200">후원 완료 감사 문자</strong>는 크리에이터가 스튜디오에서 직접 설정할 수
            있습니다. 크리에이터가 설정한 경우 그 문구가 우선하고, 설정하지 않은 크리에이터에게만 여기 문구가
            나갑니다.
          </Notice>
        </div>
        <div className="mt-3 grid gap-4 xl:grid-cols-2">{generalCodes.map(templateCard)}</div>
      </section>

      {lockedCodes.length > 0 ? (
        <section className="mt-8">
          <SectionTitle title="수정할 수 없는 문자" description="코드에서만 관리합니다." />
          <div className="mt-3 grid gap-4 xl:grid-cols-2">
            {lockedCodes.map((code) => {
              const meta = MT_TEMPLATE_META[code];
              return (
                <Card key={code}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle>{meta.label}</CardTitle>
                    <div className="flex items-center gap-1.5">
                      <Badge tone="neutral">읽기 전용</Badge>
                      <span className="font-mono text-[11px] text-ink-400">{code}</span>
                    </div>
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-400">{meta.description}</p>
                  <p className="mt-2 rounded-xl border border-ink-100 bg-ink-50 p-3 text-[12px] leading-relaxed text-ink-700">
                    {meta.defaultBody}
                  </p>
                </Card>
              );
            })}
          </div>
        </section>
      ) : null}
    </>
  );
}
